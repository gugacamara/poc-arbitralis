import type { Logger } from '../../../application/ports/logger.js';
import type { EnqueueIncomingMessages } from '../../../application/use-cases/enqueue-incoming-messages.js';
import { extractIncomingMessages } from '../meta-webhook-payload.js';

/**
 * Resposta HTTP independente de framework.
 *
 * O status e parametro de tipo, e nao um `number`: assim o compilador garante
 * que este endpoint so pode devolver 202, e a rota casa exatamente com o
 * schema declarado no Fastify.
 */
export interface HttpResponse<TStatus extends number, TBody> {
  readonly status: TStatus;
  readonly body: TBody;
}

export interface WebhookAcceptedResponse {
  readonly status: 'accepted';
  readonly accepted: number;
}

export interface WebhookControllerDependencies {
  readonly enqueueIncomingMessages: EnqueueIncomingMessages;
  readonly logger: Logger;
}

/**
 * Ponto de entrada do webhook.
 *
 * Nao depende do Fastify: recebe o corpo ja parseado e devolve status e body.
 * A rota faz a ponte com o framework. Isso mantem o teste do comportamento
 * HTTP — inclusive o 202 — sem subir servidor, e deixa a troca de framework
 * como um detalhe de uma camada so.
 */
export class WebhookController {
  readonly #enqueueIncomingMessages: EnqueueIncomingMessages;
  readonly #logger: Logger;

  constructor(dependencies: WebhookControllerDependencies) {
    this.#enqueueIncomingMessages = dependencies.enqueueIncomingMessages;
    this.#logger = dependencies.logger;
  }

  async handle(body: unknown): Promise<HttpResponse<202, WebhookAcceptedResponse>> {
    const startedAt = Date.now();
    const messages = extractIncomingMessages(body);
    const result = await this.#enqueueIncomingMessages.execute(messages);

    // `durationMs` e a metrica que sustenta a PoC: e o tempo que a Meta espera.
    this.#logger.info('webhook accepted', {
      accepted: result.accepted,
      durationMs: Date.now() - startedAt,
    });

    // 202 Accepted, e nao 200 OK: a requisicao foi aceita para processamento,
    // que ainda nao ocorreu. O status descreve com honestidade o que aconteceu,
    // e e o contrato que autoriza responder antes de ter a resposta do LLM.
    return {
      status: 202,
      body: { status: 'accepted', accepted: result.accepted },
    };
  }
}
