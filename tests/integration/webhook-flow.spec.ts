import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LlmProvider } from '../../src/application/ports/llm-provider.js';
import type { WhatsAppGateway } from '../../src/application/ports/whatsapp-gateway.js';
import {
  PermanentIntegrationError,
  TransientIntegrationError,
} from '../../src/domain/errors/integration-error.js';
import { SimulatedWhatsAppGateway } from '../../src/infrastructure/adapters/simulated-whatsapp-gateway.js';
import { createApplication, type Application } from '../../src/main/application.js';
import { loadConfig } from '../../src/main/config/env.js';
import { createRecordingLogger, until } from '../support/fakes.js';
import { buildStatusPayload, buildTextMessagePayload } from '../support/meta-payload.js';

const config = loadConfig({
  QUEUE_CONCURRENCY: '2',
  QUEUE_MAX_ATTEMPTS: '3',
  QUEUE_RETRY_BASE_DELAY_MS: '1',
});

let application: Application | undefined;

afterEach(async () => {
  await application?.stop();
  application = undefined;
});

interface Harness {
  readonly application: Application;
  readonly recording: ReturnType<typeof createRecordingLogger>;
  readonly sent: string[];
}

/**
 * Monta a aplicacao real, trocando apenas os adapters nao-deterministas.
 *
 * `useRealGateway` mantem o `SimulatedWhatsAppGateway` de producao (com falha
 * zerada) para os testes que precisam exercitar o log de saida de verdade —
 * um fake mudo passaria na assercao de PII sem provar nada.
 */
function createHarness(llmProvider: LlmProvider, useRealGateway = false): Harness {
  const recording = createRecordingLogger();
  const sent: string[] = [];

  const recordingGateway: WhatsAppGateway = {
    sendText: async (outbound) => {
      sent.push(outbound.to);
      return { externalId: `wamid.mock-${String(sent.length)}`, sentAt: new Date() };
    },
  };

  const realGateway = new SimulatedWhatsAppGateway({
    logger: recording.logger,
    failureRate: 0,
    sleep: async () => undefined,
  });

  const whatsAppGateway: WhatsAppGateway = useRealGateway
    ? {
        sendText: async (outbound, options) => {
          sent.push(outbound.to);
          return realGateway.sendText(outbound, options);
        },
      }
    : recordingGateway;

  application = createApplication(config, {
    logger: recording.logger,
    llmProvider,
    whatsAppGateway,
  });

  return { application, recording, sent };
}

function fastLlm(): LlmProvider {
  return {
    complete: vi
      .fn()
      .mockResolvedValue({ text: 'Ja estou verificando.', model: 'mock', latencyMs: 10 }),
  };
}

describe('POST /webhook', () => {
  it('responde 202 Accepted sem aguardar o LLM', async () => {
    const { application: app } = createHarness(fastLlm());

    const response = await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'accepted', accepted: 1 });
  });

  it('responde de imediato mesmo com o LLM travado — a tese da PoC', async () => {
    // Este LLM nunca resolve. Antes, o request ficaria preso aqui ate o
    // timeout da Meta; agora ele nem participa do ciclo da requisicao.
    const stuckLlm: LlmProvider = { complete: () => new Promise(() => undefined) };
    const { application: app } = createHarness(stuckLlm);
    app.worker.start();

    const startedAt = Date.now();
    const response = await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });

    expect(response.statusCode).toBe(202);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('enfileira a mensagem para processamento posterior', async () => {
    const { application: app } = createHarness(fastLlm());

    await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });

    // O worker ainda nao foi iniciado: a mensagem esta guardada, nao perdida.
    expect((await app.queue.stats()).pending).toBe(1);
  });

  it('processa em background e entrega a resposta ao remetente', async () => {
    const { application: app, sent } = createHarness(fastLlm());
    app.worker.start();

    await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });

    await until(() => sent.length === 1, 'a resposta ser enviada');
    expect(sent[0]).toBe('5521999998888');
  });

  it('aceita varias mensagens da mesma entrega', async () => {
    const { application: app } = createHarness(fastLlm());

    const response = await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload([{ id: 'wamid.1' }, { id: 'wamid.2' }]),
    });

    expect(response.json()).toEqual({ status: 'accepted', accepted: 2 });
  });

  it('aceita evento que nao e mensagem, para nao induzir reentrega da Meta', async () => {
    const { application: app } = createHarness(fastLlm());

    const response = await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildStatusPayload(),
    });

    // 4xx faria a Meta reenviar o evento ate desabilitar o webhook.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'accepted', accepted: 0 });
  });

  it('rejeita envelope invalido, que nenhuma reentrega corrigiria', async () => {
    const { application: app } = createHarness(fastLlm());

    const response = await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { foo: 'bar' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('nao registra PII em nenhuma etapa do fluxo', async () => {
    const { application: app, recording, sent } = createHarness(fastLlm(), true);
    app.worker.start();

    await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });
    await until(() => sent.length === 1, 'concluir o fluxo');

    expect(recording.raw()).not.toContain('5521999998888');
    expect(recording.raw()).not.toContain('João da Silva');
    expect(recording.raw()).not.toContain('Qual o status do meu processo');
    expect(recording.raw()).toContain('55*******8888');
  });
});

describe('POST /webhook — resiliencia a falhas do LLM', () => {
  it('nao perde a mensagem quando o LLM falha de forma intermitente', async () => {
    let calls = 0;
    const flakyLlm: LlmProvider = {
      complete: async () => {
        calls += 1;
        if (calls < 3) {
          throw new TransientIntegrationError('LLM upstream timed out');
        }
        return { text: 'Resposta', model: 'mock', latencyMs: 10 };
      },
    };

    const { application: app, sent } = createHarness(flakyLlm);
    app.worker.start();

    const response = await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });

    expect(response.statusCode).toBe(202);
    await until(() => sent.length === 1, 'a resposta ser entregue apos os retries');
    expect(calls).toBe(3);
    expect((await app.deadLetterQueue.stats()).pending).toBe(0);
  });

  it('preserva na DLQ a mensagem que esgota as tentativas', async () => {
    const brokenLlm: LlmProvider = {
      complete: () => Promise.reject(new TransientIntegrationError('LLM sempre fora')),
    };

    const { application: app } = createHarness(brokenLlm);
    app.worker.start();

    await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload([{ id: 'wamid.DLQ' }]),
    });

    await until(() => app.worker.stats().deadLettered === 1, 'a mensagem cair na DLQ');

    // Nao se perde: fica recuperavel, e o /health torna o problema visivel.
    const deadLettered = await app.deadLetterQueue.dequeue();
    expect(deadLettered?.payload.messageId).toBe('wamid.DLQ');
  });

  it('nao desperdica tentativas com falha permanente', async () => {
    let calls = 0;
    const rejectingLlm: LlmProvider = {
      complete: () => {
        calls += 1;
        return Promise.reject(new PermanentIntegrationError('LLM rejected (400)'));
      },
    };

    const { application: app } = createHarness(rejectingLlm);
    app.worker.start();

    await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload(),
    });

    await until(() => app.worker.stats().deadLettered === 1, 'a DLQ imediata');
    expect(calls).toBe(1);
  });

  it('continua aceitando mensagens novas enquanto o LLM esta fora', async () => {
    const stuckLlm: LlmProvider = { complete: () => new Promise(() => undefined) };
    const { application: app } = createHarness(stuckLlm);
    app.worker.start();

    for (let i = 0; i < 5; i++) {
      const response = await app.app.inject({
        method: 'POST',
        url: '/webhook',
        payload: buildTextMessagePayload([{ id: `wamid.${String(i)}` }]),
      });

      // A ingestao nao degrada junto com o upstream: e o desacoplamento.
      expect(response.statusCode).toBe(202);
    }
  });
});

describe('GET /health', () => {
  it('expoe o estado da fila e do worker', async () => {
    const { application: app } = createHarness(fastLlm());

    const response = await app.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      queue: { pending: 0, inFlight: 0, deadLettered: 0 },
      worker: { running: false, processed: 0 },
    });
  });

  it('revela acumulo na fila quando o worker nao acompanha', async () => {
    const stuckLlm: LlmProvider = { complete: () => new Promise(() => undefined) };
    const { application: app } = createHarness(stuckLlm);

    await app.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: buildTextMessagePayload([{ id: 'wamid.1' }, { id: 'wamid.2' }]),
    });

    // Responder 202 nao prova que as mensagens estao sendo processadas.
    expect(
      (await app.app.inject({ method: 'GET', url: '/health' })).json(),
    ).toMatchObject({ queue: { pending: 2 } });
  });
});
