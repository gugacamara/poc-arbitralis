/** Constroi payloads no formato da Meta Cloud API para os testes. */
export interface TextMessageInput {
  readonly id?: string;
  readonly from?: string;
  readonly body?: string;
  readonly timestamp?: string;
}

export function buildTextMessagePayload(
  messages: readonly TextMessageInput[] = [{}],
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '5511988887777',
                phone_number_id: '109',
              },
              contacts: [{ profile: { name: 'João da Silva' }, wa_id: '5521999998888' }],
              messages: messages.map((message, index) => ({
                from: message.from ?? '5521999998888',
                id: message.id ?? `wamid.TEST${String(index)}`,
                timestamp: message.timestamp ?? '1768471200',
                type: 'text',
                text: { body: message.body ?? 'Qual o status do meu processo?' },
              })),
            },
          },
        ],
      },
    ],
  };
}

/** Evento de status de entrega: chega no mesmo endpoint e nao e mensagem. */
export function buildStatusPayload(): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }],
  };
}
