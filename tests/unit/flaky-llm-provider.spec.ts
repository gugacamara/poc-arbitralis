import { describe, expect, it, vi } from 'vitest';

import {
  isRetryable,
  PermanentIntegrationError,
  TransientIntegrationError,
} from '../../src/domain/errors/integration-error.js';
import { FlakyLlmProvider } from '../../src/infrastructure/adapters/flaky-llm-provider.js';
import { instantSleep, seededRandom } from '../support/fakes.js';

const request = { conversationId: '5521999998888', prompt: 'Qual o status?' };

describe('FlakyLlmProvider', () => {
  it('responde no caminho feliz reportando modelo e latencia', async () => {
    const provider = new FlakyLlmProvider({
      minLatencyMs: 1_000,
      maxLatencyMs: 5_000,
      failureRate: 0,
      random: seededRandom([0.5]),
      sleep: instantSleep,
    });

    const reply = await provider.complete(request);

    expect(reply.latencyMs).toBe(3_000);
    expect(reply.model).toBe('mock-llm-v1');
    expect(reply.text).toContain('Qual o status?');
  });

  it('aguarda de fato a latencia sorteada', async () => {
    const sleep = vi.fn(instantSleep);
    const provider = new FlakyLlmProvider({
      minLatencyMs: 2_000,
      maxLatencyMs: 2_000,
      failureRate: 0,
      sleep,
    });

    await provider.complete(request);

    // Um mock que so *reporta* a latencia esconderia o custo que a fila absorve.
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
  });

  it('classifica falha de upstream como transitoria', async () => {
    const provider = new FlakyLlmProvider({
      failureRate: 1,
      random: seededRandom([0.5, 0, 0]),
      sleep: instantSleep,
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(
      TransientIntegrationError,
    );
  });

  it('classifica rejeicao do provedor como permanente', async () => {
    const provider = new FlakyLlmProvider({
      failureRate: 0,
      permanentFailureRate: 1,
      random: seededRandom([0.5, 0.9, 0]),
      sleep: instantSleep,
    });

    const error = await provider.complete(request).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PermanentIntegrationError);
    expect(isRetryable(error)).toBe(false);
  });

  it('falha apos a espera, como faz um upstream real', async () => {
    const sleep = vi.fn(instantSleep);
    const provider = new FlakyLlmProvider({
      failureRate: 1,
      random: seededRandom([0.5, 0, 0]),
      sleep,
    });

    await expect(provider.complete(request)).rejects.toThrow();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('rejeita prompt vazio de imediato, sem pagar a latencia', async () => {
    const sleep = vi.fn(instantSleep);
    const provider = new FlakyLlmProvider({ failureRate: 0, sleep });

    // Nenhum retry transforma prompt vazio em resposta.
    await expect(provider.complete({ ...request, prompt: '   ' })).rejects.toBeInstanceOf(
      PermanentIntegrationError,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('aborta a chamada quando o signal dispara', async () => {
    const provider = new FlakyLlmProvider({ minLatencyMs: 5_000, failureRate: 0 });
    const controller = new AbortController();

    const pending = provider.complete(request, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('isRetryable', () => {
  it('trata erro desconhecido como transitorio, por conservadorismo', () => {
    // Desistir de uma falha nao mapeada perderia a mensagem; o limite de
    // tentativas do worker impede repeticao infinita.
    expect(isRetryable(new TypeError('bug'))).toBe(true);
  });

  it('usa o nome da subclasse no erro', () => {
    expect(new TransientIntegrationError('x').name).toBe('TransientIntegrationError');
    expect(new PermanentIntegrationError('x').name).toBe('PermanentIntegrationError');
  });
});
