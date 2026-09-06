import type { Logger } from '../ports/logger.js';
import type { Queue } from '../ports/queue.js';
import type { IncomingMessage } from '../../domain/entities/incoming-message.js';

export interface EnqueueIncomingMessagesDependencies {
  readonly queue: Queue<IncomingMessage>;
  readonly logger: Logger;
}

export interface EnqueueIncomingMessagesResult {
  readonly accepted: number;
  readonly queueMessageIds: readonly string[];
}

/**
 * Registra mensagens recebidas para processamento posterior.
 *
 * E todo o trabalho sincrono que o webhook realiza. Tudo o que for caro —
 * consultar o LLM, responder ao usuario — acontece depois, no worker. Manter
 * este caso de uso deliberadamente magro e o que garante que a resposta a Meta
 * caiba com folga dentro do timeout da plataforma.
 *
 * E tambem o ponto de extensao natural para deduplicacao por `messageId`, que
 * a Meta exige na pratica porque reentrega o mesmo evento quando nao recebe
 * confirmacao a tempo.
 */
export class EnqueueIncomingMessages {
  readonly #queue: Queue<IncomingMessage>;
  readonly #logger: Logger;

  constructor(dependencies: EnqueueIncomingMessagesDependencies) {
    this.#queue = dependencies.queue;
    this.#logger = dependencies.logger;
  }

  async execute(
    messages: readonly IncomingMessage[],
  ): Promise<EnqueueIncomingMessagesResult> {
    const queueMessageIds: string[] = [];

    for (const message of messages) {
      const queued = await this.#queue.enqueue(message);
      queueMessageIds.push(queued.id);

      this.#logger.info('message enqueued', {
        messageId: message.messageId,
        queueMessageId: queued.id,
      });
    }

    return { accepted: messages.length, queueMessageIds };
  }
}
