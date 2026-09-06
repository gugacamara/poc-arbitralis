import type { Logger } from '../ports/logger.js';
import type { LlmProvider } from '../ports/llm-provider.js';
import type { WhatsAppGateway } from '../ports/whatsapp-gateway.js';
import type { IncomingMessage } from '../../domain/entities/incoming-message.js';

export interface ProcessIncomingMessageDependencies {
  readonly llmProvider: LlmProvider;
  readonly whatsAppGateway: WhatsAppGateway;
  readonly logger: Logger;
}

export interface ProcessIncomingMessageOptions {
  readonly signal?: AbortSignal;
}

/**
 * Consulta o LLM e responde ao remetente.
 *
 * E o trabalho que antes acontecia dentro do request HTTP da Meta — e a causa
 * do timeout. Aqui ele roda fora do ciclo de vida da requisicao, sem prazo
 * imposto pela plataforma.
 *
 * O caso de uso nao conhece fila, retry nem HTTP: recebe uma mensagem, executa
 * *uma* tentativa e falha alto se algo der errado. Decidir se aquela falha
 * merece nova tentativa e responsabilidade do worker, que e quem tem o
 * contexto de quantas ja houve.
 */
export class ProcessIncomingMessage {
  readonly #llmProvider: LlmProvider;
  readonly #whatsAppGateway: WhatsAppGateway;
  readonly #logger: Logger;

  constructor(dependencies: ProcessIncomingMessageDependencies) {
    this.#llmProvider = dependencies.llmProvider;
    this.#whatsAppGateway = dependencies.whatsAppGateway;
    this.#logger = dependencies.logger;
  }

  async execute(
    message: IncomingMessage,
    options: ProcessIncomingMessageOptions = {},
  ): Promise<void> {
    const logger = this.#logger.child({ messageId: message.messageId });
    const startedAt = Date.now();

    const reply = await this.#llmProvider.complete(
      { conversationId: message.from, prompt: message.text },
      options,
    );

    logger.info('llm replied', {
      model: reply.model,
      llmLatencyMs: reply.latencyMs,
    });

    const sent = await this.#whatsAppGateway.sendText(
      {
        to: message.from,
        text: reply.text,
        replyToMessageId: message.messageId,
      },
      options,
    );

    logger.info('reply delivered', {
      externalId: sent.externalId,
      // Tempo total fora do request HTTP: a metrica que prova a tese da PoC.
      totalDurationMs: Date.now() - startedAt,
    });
  }
}
