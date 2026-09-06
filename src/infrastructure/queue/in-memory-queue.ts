import { randomUUID } from 'node:crypto';

import {
  MessageNotInFlightError,
  type EnqueueOptions,
  type NackOptions,
  type Queue,
  type QueueMessage,
  type QueueStats,
} from '../../application/ports/queue.js';

/** Estado interno mutavel. Nunca escapa da classe — consumidores recebem snapshots. */
interface StoredMessage<TPayload> {
  readonly id: string;
  readonly payload: TPayload;
  readonly enqueuedAt: Date;
  attempts: number;
  availableAt: Date;
}

export interface InMemoryQueueOptions<TPayload> {
  /**
   * Destino das mensagens descartadas via `nack(id, { requeue: false })`.
   *
   * Modelar a DLQ como *outra fila* — e nao como um array interno — espelha a
   * redrive policy do SQS e permite reprocessar o que caiu nela com o mesmo
   * consumidor. Sem DLQ configurada a mensagem e descartada, mas continua
   * contabilizada em `stats().deadLettered`.
   */
  readonly deadLetterQueue?: Queue<TPayload>;
}

/**
 * Fila FIFO em memoria, com in-flight tracking, backoff e dead-lettering.
 *
 * Escopo consciente de PoC: o estado vive no heap de um unico processo, entao
 * um restart perde as mensagens pendentes e in-flight. O ADR documenta o
 * trade-off e o caminho para producao.
 *
 * A ordem e FIFO entre mensagens *elegiveis*: uma mensagem em backoff cede a
 * vez para as que ja estao disponiveis, exatamente como num broker real.
 */
export class InMemoryQueue<TPayload> implements Queue<TPayload> {
  readonly #pending: StoredMessage<TPayload>[] = [];
  readonly #inFlight = new Map<string, StoredMessage<TPayload>>();
  readonly #deadLetterQueue: Queue<TPayload> | undefined;
  #deadLetteredCount = 0;

  constructor(options: InMemoryQueueOptions<TPayload> = {}) {
    this.#deadLetterQueue = options.deadLetterQueue;
  }

  enqueue(
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<QueueMessage<TPayload>> {
    const now = Date.now();
    const message: StoredMessage<TPayload> = {
      id: randomUUID(),
      payload,
      enqueuedAt: new Date(now),
      attempts: 0,
      availableAt: new Date(now + (options.delayMs ?? 0)),
    };

    this.#pending.push(message);
    return Promise.resolve(toSnapshot(message));
  }

  dequeue(): Promise<QueueMessage<TPayload> | undefined> {
    const now = Date.now();
    const message = this.#pending.find(
      (candidate) => candidate.availableAt.getTime() <= now,
    );

    if (message === undefined) {
      return Promise.resolve(undefined);
    }

    this.#pending.splice(this.#pending.indexOf(message), 1);
    message.attempts += 1;
    this.#inFlight.set(message.id, message);

    return Promise.resolve(toSnapshot(message));
  }

  ack(messageId: string): Promise<void> {
    const message = this.#releaseInFlight(messageId);

    // Rejeitar em vez de lancar: quem consome um metodo `Promise`-based trata o
    // erro no `.catch()`/`try` do `await`, e uma excecao sincrona escaparia dele.
    return message === undefined
      ? Promise.reject(new MessageNotInFlightError(messageId))
      : Promise.resolve();
  }

  async nack(messageId: string, options: NackOptions = {}): Promise<void> {
    const message = this.#releaseInFlight(messageId);

    if (message === undefined) {
      throw new MessageNotInFlightError(messageId);
    }

    if (options.requeue ?? true) {
      message.availableAt = new Date(Date.now() + (options.retryDelayMs ?? 0));
      this.#pending.push(message);
      return;
    }

    this.#deadLetteredCount += 1;
    await this.#deadLetterQueue?.enqueue(message.payload);
  }

  stats(): Promise<QueueStats> {
    return Promise.resolve({
      pending: this.#pending.length,
      inFlight: this.#inFlight.size,
      deadLettered: this.#deadLetteredCount,
    });
  }

  /** Tira a mensagem do in-flight. `undefined` sinaliza ack/nack orfao. */
  #releaseInFlight(messageId: string): StoredMessage<TPayload> | undefined {
    const message = this.#inFlight.get(messageId);
    this.#inFlight.delete(messageId);
    return message;
  }
}

/**
 * Copia rasa defensiva: impede que o consumidor mute o estado da fila.
 * O `payload` segue por referencia — clonar em profundidade custaria caro e o
 * consumidor o trata como imutavel por contrato.
 */
function toSnapshot<TPayload>(message: StoredMessage<TPayload>): QueueMessage<TPayload> {
  return {
    id: message.id,
    payload: message.payload,
    attempts: message.attempts,
    enqueuedAt: new Date(message.enqueuedAt),
    availableAt: new Date(message.availableAt),
  };
}
