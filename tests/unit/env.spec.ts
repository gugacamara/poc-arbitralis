import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/main/config/env.js';

describe('loadConfig', () => {
  it('aplica padroes utilizaveis quando nada e informado', () => {
    const config = loadConfig({});

    expect(config.http).toEqual({ port: 3_000, host: '0.0.0.0' });
    expect(config.logLevel).toBe('info');
    expect(config.worker.maxAttempts).toBe(3);
  });

  it('le os valores informados', () => {
    const config = loadConfig({
      PORT: '8080',
      LOG_LEVEL: 'debug',
      LLM_FAILURE_RATE: '0.5',
    });

    expect(config.http.port).toBe(8_080);
    expect(config.logLevel).toBe('debug');
    expect(config.llm.failureRate).toBe(0.5);
  });

  it('trata string vazia como ausente', () => {
    expect(loadConfig({ PORT: '' }).http.port).toBe(3_000);
  });

  // Falhar no boot e proposital: melhor derrubar o deploy do que descobrir a
  // configuracao invalida horas depois, no meio do processamento.
  it.each([
    ['PORT nao numerico', { PORT: 'abc' }],
    ['PORT negativo', { PORT: '-1' }],
    ['nivel de log invalido', { LOG_LEVEL: 'verbose' }],
    ['taxa de falha acima de 1', { LLM_FAILURE_RATE: '1.5' }],
    ['latencia minima maior que a maxima', { LLM_MIN_LATENCY_MS: '9000' }],
  ])('rejeita %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
