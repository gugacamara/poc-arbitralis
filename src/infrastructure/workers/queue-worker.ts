import type { Logger } from '../../application/ports/logger.js';
import type { Queue, QueueMessage } from '../../application/ports/queue.js';
import {
  isRetryable,
  TransientIntegrationError,
} from '../../domain/errors/integration-error.js';
import { sleep, type Sleep } from '../support/sleep.js';

export type QueueMessageHandler<TPayload> = (
  payload: TPayload,
  context: { readonly signal: AbortSignal },
) => Promise<void>;

export interface WorkerStats {
  readonly running: boolean;
  readonly processed: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export interface QueueWorkerOptions<TPayload> {
  readonly queue: Queue<TPayload>;
  readonly handler: QueueMessageHandler<TPayload>;
  readonly logger: Logger;
  /** Quantas mensagens sao processadas em paralelo. Padrao: 2. */
  readonly concurrency?: number;
  /** Tentativas totais antes da DLQ, incluindo a primeira. Padrao: 3. */
  readonly maxAttempts?: number;
  /** Base do backoff exponencial. Padrao: 250ms. */
  readonly retryBaseDelayMs?: number;
  /** Teto do backoff, para que a 10a tentativa nao caia daqui a horas. */
  readonly maxRetryDelayMs?: number;
  /** Prazo de uma tentativa. Padrao: 15s. */
  readonly handlerTimeoutMs?: number;
  /** Intervalo entre sondagens quando a fila esta vazia. Padrao: 25ms. */
  readonly idlePollIntervalMs?: number;
  readonly random?: () => number;
  readonly sleep?: Sleep;
}

/**
 * Consumidor em background: retira mensagens da fila e as entrega ao handler,
 * aplicando concorrencia, timeout, retry com backoff e dead-lettering.
 *
 * Divisao de responsabilidades: a fila oferece o *mecanismo* (ack, nack,
 * backoff, DLQ) e o worker define a *politica* (quantas tentativas, qual
 * curva, quando desistir). Sao os dois eixos que mudam por motivos diferentes
 * — trocar o broker nao deveria exigir rediscutir a politica de retry, e
 * ajustar a politica nao deveria tocar no adapter da fila.
 *
 * Generico sobre o payload: o worker nao sabe o que e uma mensagem de
 * WhatsApp, o que o torna reutilizavel e testavel com payloads triviais.
 */
export class QueueWorker<TPayload> {
  readonly #queue: Queue<TPayload>;
  readonly #handler: QueueMessageHandler<TPayload>;
  readonly #logger: Logger;
  readonly #concurrency: number;
  readonly #maxAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #handlerTimeoutMs: number;
  readonly #idlePollIntervalMs: number;
  readonly #random: () => number;
  readonly #sleep: Sleep;

  #loops: Promise<void>[] = [];
  #shutdown = new AbortController();
  #running = false;
  #processed = 0;
  #retried = 0;
  #deadLettered = 0;

  constructor(options: QueueWorkerOptions<TPayload>) {
    this.#queue = options.queue;
    this.#handler = options.handler;
    this.#logger = options.logger;
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.#handlerTimeoutMs = options.handlerTimeoutMs ?? 15_000;
    this.#idlePollIntervalMs = options.idlePollIntervalMs ?? 25;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? sleep;
  }

  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#shutdown = new AbortController();
    this.#loops = Array.from({ length: this.#concurrency }, () => this.#loop());

    this.#logger.info('worker started', { concurrency: this.#concurrency });
  }

  /**
   * Encerramento gracioso: para de retirar mensagens novas e aguarda as que ja
   * estao em andamento. Sem isso, um deploy descartaria silenciosamente o
   * trabalho em voo — o mesmo sintoma do incidente original, com outra causa.
   */
  async stop(): Promise<void> {
    if (!this.#running) {
      return;
    }

    this.#running = false;
    // Interrompe a espera ociosa para nao atrasar o shutdown em ate um ciclo.
    this.#shutdown.abort();

    await Promise.all(this.#loops);
    this.#loops = [];

    this.#logger.info('worker stopped', {
      processed: this.#processed,
      retried: this.#retried,
      deadLettered: this.#deadLettered,
    });
  }

  stats(): WorkerStats {
    return {
      running: this.#running,
      processed: this.#processed,
      retried: this.#retried,
      deadLettered: this.#deadLettered,
    };
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const message = await this.#queue.dequeue();

      if (message === undefined) {
        await this.#waitWhileIdle();
        continue;
      }

      await this.#process(message);
    }
  }

  /**
   * Sondagem simples, adequada a uma fila em memoria. Um broker real oferece
   * long-polling ou push, eliminando a espera ociosa — mais um ganho que vem
   * de graca ao trocar o adapter.
   */
  async #waitWhileIdle(): Promise<void> {
    try {
      await this.#sleep(this.#idlePollIntervalMs, this.#shutdown.signal);
    } catch {
      // Abortado por stop(): a condicao do while encerra o loop.
    }
  }

  async #process(message: QueueMessage<TPayload>): Promise<void> {
    const logger = this.#logger.child({
      queueMessageId: message.id,
      attempt: message.attempts,
    });
    const startedAt = Date.now();

    try {
      await this.#runWithTimeout(message.payload);
      await this.#queue.ack(message.id);
      this.#processed += 1;

      logger.info('message processed', { durationMs: Date.now() - startedAt });
    } catch (error) {
      await this.#settleFailure(message, error, logger);
    }
  }

  async #settleFailure(
    message: QueueMessage<TPayload>,
    error: unknown,
    logger: Logger,
  ): Promise<void> {
    const retryable = isRetryable(error);
    const attemptsExhausted = message.attempts >= this.#maxAttempts;

    try {
      if (!retryable || attemptsExhausted) {
        await this.#queue.nack(message.id, { requeue: false });
        this.#deadLettered += 1;

        logger.error('message dead-lettered', {
          reason: retryable ? 'attempts exhausted' : 'permanent failure',
          attempts: message.attempts,
          error,
        });
        return;
      }

      const retryDelayMs = this.#backoffFor(message.attempts);
      await this.#queue.nack(message.id, { requeue: true, retryDelayMs });
      this.#retried += 1;

      logger.warn('message scheduled for retry', { retryDelayMs, error });
    } catch (settleError) {
      // O loop nao pode morrer aqui: um worker que para em silencio e pior que
      // uma mensagem perdida, porque leva junto todas as proximas.
      logger.error('failed to settle message', { error: settleError });
    }
  }

  /**
   * Impoe prazo a uma tentativa.
   *
   * A corrida garante que o slot de concorrencia seja liberado mesmo se o
   * handler ignorar o `signal` — JavaScript nao permite matar uma promise, e
   * sem a corrida um handler mal-comportado travaria o worker para sempre. O
   * `abort` avisa quem for cooperativo (todos os adapters desta PoC sao).
   */
  async #runWithTimeout(payload: TPayload): Promise<void> {
    const controller = new AbortController();
    const timeoutError = new TransientIntegrationError(
      `handler timed out after ${String(this.#handlerTimeoutMs)}ms`,
    );

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.#handlerTimeoutMs);
    });

    const work = this.#handler(payload, { signal: controller.signal });
    // Handler que ignora o abort segue rodando apos a corrida; sem este catch a
    // rejeicao tardia viraria unhandledRejection e derrubaria o processo.
    void work.catch(() => undefined);

    try {
      await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Backoff exponencial com jitter.
   *
   * O jitter nao e enfeite: sem ele, uma indisponibilidade do LLM sincroniza
   * todas as mensagens em falha e elas voltam juntas, no mesmo instante,
   * derrubando o upstream de novo assim que ele se recupera.
   */
  #backoffFor(attempts: number): number {
    const exponential = this.#retryBaseDelayMs * 2 ** (attempts - 1);
    const capped = Math.min(exponential, this.#maxRetryDelayMs);

    return Math.round(capped * (0.5 + this.#random() * 0.5));
  }
}
