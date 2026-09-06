import { randomUUID } from 'node:crypto';

import type { Logger } from '../../application/ports/logger.js';
import type {
  OutboundTextMessage,
  SendOptions,
  SendResult,
  WhatsAppGateway,
} from '../../application/ports/whatsapp-gateway.js';
import { TransientIntegrationError } from '../../domain/errors/integration-error.js';
import { sleep, type Sleep } from '../support/sleep.js';

export interface SimulatedWhatsAppGatewayOptions {
  readonly logger: Logger;
  readonly minLatencyMs?: number;
  readonly maxLatencyMs?: number;
  /** Probabilidade de falha transitoria (0..1). */
  readonly failureRate?: number;
  readonly random?: () => number;
  readonly sleep?: Sleep;
  readonly now?: () => Date;
}

/**
 * Mock do outbound call para a Cloud API do WhatsApp.
 *
 * Substitui a chamada HTTP real pelo unico efeito observavel que a PoC precisa:
 * um registro de log provando que a resposta saiu *depois* do 202, fora do
 * ciclo de vida da requisicao original.
 *
 * A latencia e menor e a taxa de falha bem mais baixa que a do LLM, refletindo
 * a realidade: a API do WhatsApp e rapida e estavel; o gargalo e o modelo.
 * Ainda assim ela falha as vezes — e uma falha *aqui* e mais interessante que
 * uma falha no LLM, porque acontece depois de todo o trabalho caro ja ter sido
 * feito. E o que justifica o worker tratar as duas etapas na mesma tentativa.
 */
export class SimulatedWhatsAppGateway implements WhatsAppGateway {
  readonly #logger: Logger;
  readonly #minLatencyMs: number;
  readonly #maxLatencyMs: number;
  readonly #failureRate: number;
  readonly #random: () => number;
  readonly #sleep: Sleep;
  readonly #now: () => Date;

  constructor(options: SimulatedWhatsAppGatewayOptions) {
    this.#logger = options.logger;
    this.#minLatencyMs = options.minLatencyMs ?? 50;
    this.#maxLatencyMs = options.maxLatencyMs ?? 250;
    this.#failureRate = options.failureRate ?? 0.05;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? sleep;
    this.#now = options.now ?? (() => new Date());
  }

  async sendText(
    message: OutboundTextMessage,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const span = Math.max(0, this.#maxLatencyMs - this.#minLatencyMs);
    const latencyMs = Math.round(this.#minLatencyMs + this.#random() * span);

    await this.#sleep(latencyMs, options.signal);

    if (this.#random() < this.#failureRate) {
      throw new TransientIntegrationError('WhatsApp Cloud API unavailable (503)');
    }

    const result: SendResult = {
      externalId: `wamid.mock-${randomUUID()}`,
      sentAt: this.#now(),
    };

    // `to` e `text` sao mascarados pelo logger — este e o ponto do sistema onde
    // PII e mais tentadora de logar "so para depurar".
    this.#logger.info('outbound message sent', {
      to: message.to,
      text: message.text,
      externalId: result.externalId,
      replyToMessageId: message.replyToMessageId,
      latencyMs,
    });

    return result;
  }
}
