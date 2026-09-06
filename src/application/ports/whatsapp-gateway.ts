/** Contrato de envio de mensagens (outbound call) para o WhatsApp. */

export interface OutboundTextMessage {
  /** Numero do destinatario em formato E.164, sem `+`. */
  readonly to: string;
  readonly text: string;
  /** Id da mensagem original, quando a resposta deve aparecer como reply. */
  readonly replyToMessageId?: string;
}

export interface SendResult {
  /** Id atribuido pelo WhatsApp (`wamid.*`). */
  readonly externalId: string;
  readonly sentAt: Date;
}

export interface SendOptions {
  readonly signal?: AbortSignal;
}

export interface WhatsAppGateway {
  sendText(message: OutboundTextMessage, options?: SendOptions): Promise<SendResult>;
}
