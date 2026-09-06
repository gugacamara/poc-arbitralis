import type { IncomingMessage } from '../../domain/entities/incoming-message.js';

/**
 * Schema do envelope do webhook da Meta.
 *
 * Valida *apenas* o envelope, de proposito. A Meta entrega no mesmo endpoint
 * dezenas de eventos que nao nos interessam (status de entrega, reacoes,
 * mensagens de midia) e o formato evolui sem aviso. Um schema rigido responderia
 * 400 a eventos legitimos, e a Meta trata 4xx como falha de entrega: ela
 * reenviaria o mesmo evento repetidamente e acabaria desabilitando o webhook.
 *
 * A postura correta e a de Postel: rigoroso no que emitimos, tolerante no que
 * aceitamos. Extraimos o que reconhecemos, ignoramos o resto, confirmamos o
 * recebimento.
 */
export const metaWebhookBodySchema = {
  type: 'object',
  required: ['object', 'entry'],
  properties: {
    object: { type: 'string' },
    entry: { type: 'array' },
  },
  additionalProperties: true,
} as const;

export const webhookAcceptedResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    accepted: { type: 'integer' },
  },
  required: ['status', 'accepted'],
} as const;

/**
 * Extrai as mensagens de texto de um payload da Cloud API.
 *
 * Percorre a estrutura de forma defensiva: qualquer no fora do formato
 * esperado e simplesmente ignorado, nunca lancado como erro. O payload vem de
 * fora e nao ha ganho em derrubar a ingestao por causa de um campo inesperado.
 */
export function extractIncomingMessages(payload: unknown): IncomingMessage[] {
  const messages: IncomingMessage[] = [];

  for (const entry of asArray(asRecord(payload)?.['entry'])) {
    for (const change of asArray(asRecord(entry)?.['changes'])) {
      const value = asRecord(asRecord(change)?.['value']);

      for (const raw of asArray(value?.['messages'])) {
        const message = toIncomingMessage(raw);

        if (message !== undefined) {
          messages.push(message);
        }
      }
    }
  }

  return messages;
}

function toIncomingMessage(raw: unknown): IncomingMessage | undefined {
  const record = asRecord(raw);

  if (record === undefined || record['type'] !== 'text') {
    return undefined;
  }

  const messageId = asNonEmptyString(record['id']);
  const from = asNonEmptyString(record['from']);
  const text = asNonEmptyString(asRecord(record['text'])?.['body']);

  if (messageId === undefined || from === undefined || text === undefined) {
    return undefined;
  }

  return { messageId, from, text, receivedAt: toDate(record['timestamp']) };
}

/** A Meta envia epoch em segundos, como string. */
function toDate(timestamp: unknown): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000) : new Date();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
