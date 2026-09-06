import { describe, expect, it } from 'vitest';

import { extractIncomingMessages } from '../../src/presentation/http/meta-webhook-payload.js';
import { buildStatusPayload, buildTextMessagePayload } from '../support/meta-payload.js';

describe('extractIncomingMessages', () => {
  it('extrai a mensagem de texto do payload da Meta', () => {
    const [message] = extractIncomingMessages(
      buildTextMessagePayload([{ id: 'wamid.1', body: 'Ola' }]),
    );

    expect(message).toEqual({
      messageId: 'wamid.1',
      from: '5521999998888',
      text: 'Ola',
      receivedAt: new Date(1_768_471_200_000),
    });
  });

  it('extrai varias mensagens da mesma entrega', () => {
    const messages = extractIncomingMessages(
      buildTextMessagePayload([{ id: 'wamid.1' }, { id: 'wamid.2' }]),
    );

    expect(messages.map((message) => message.messageId)).toEqual(['wamid.1', 'wamid.2']);
  });

  // A Meta trata 4xx como falha de entrega e reenvia; ignorar em silencio o
  // que nao reconhecemos e o que impede o webhook de ser desabilitado.
  it.each([
    ['evento de status de entrega', buildStatusPayload()],
    ['payload vazio', {}],
    ['entry que nao e array', { entry: 'nao-array' }],
    ['nulo', null],
    ['string', 'texto solto'],
  ])('ignora %s sem lancar erro', (_label, payload) => {
    expect(extractIncomingMessages(payload)).toEqual([]);
  });

  it('ignora tipos ainda nao suportados e mantem os de texto', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '5521999990000', id: 'wamid.IMG', type: 'image' },
                  {
                    from: '5521999991111',
                    id: 'wamid.TXT',
                    type: 'text',
                    timestamp: '1768471200',
                    text: { body: 'ola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload).map((m) => m.messageId)).toEqual([
      'wamid.TXT',
    ]);
  });

  it.each([
    ['sem id', { id: '' }],
    ['sem remetente', { from: '' }],
    ['sem corpo', { body: '' }],
  ])('descarta mensagem %s, que nao teria como ser respondida', (_label, overrides) => {
    expect(extractIncomingMessages(buildTextMessagePayload([overrides]))).toEqual([]);
  });

  it('usa o instante atual quando o timestamp e invalido', () => {
    const before = Date.now();
    const [message] = extractIncomingMessages(
      buildTextMessagePayload([{ timestamp: 'invalido' }]),
    );

    expect(message!.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
