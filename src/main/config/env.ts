import type { LogLevel } from '../../application/ports/logger.js';

export interface AppConfig {
  readonly http: { readonly port: number; readonly host: string };
  readonly logLevel: LogLevel;
  readonly worker: {
    readonly concurrency: number;
    readonly maxAttempts: number;
    readonly retryBaseDelayMs: number;
    readonly handlerTimeoutMs: number;
  };
  readonly llm: {
    readonly minLatencyMs: number;
    readonly maxLatencyMs: number;
    readonly failureRate: number;
  };
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Le e valida a configuracao no boot.
 *
 * Falhar aqui e proposital: uma variavel invalida deve derrubar o processo na
 * inicializacao, quando o deploy ainda pode ser revertido, e nao horas depois
 * no meio do processamento de uma mensagem.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    http: {
      port: readInt(env, 'PORT', 3_000),
      host: env['HOST'] ?? '0.0.0.0',
    },
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
    worker: {
      concurrency: readInt(env, 'QUEUE_CONCURRENCY', 2),
      maxAttempts: readInt(env, 'QUEUE_MAX_ATTEMPTS', 3),
      retryBaseDelayMs: readInt(env, 'QUEUE_RETRY_BASE_DELAY_MS', 250),
      handlerTimeoutMs: readInt(env, 'QUEUE_HANDLER_TIMEOUT_MS', 15_000),
    },
    llm: {
      minLatencyMs: readInt(env, 'LLM_MIN_LATENCY_MS', 500),
      maxLatencyMs: readInt(env, 'LLM_MAX_LATENCY_MS', 4_000),
      failureRate: readFloat(env, 'LLM_FAILURE_RATE', 0.3),
    },
  };

  if (config.llm.minLatencyMs > config.llm.maxLatencyMs) {
    throw new Error('LLM_MIN_LATENCY_MS must not exceed LLM_MAX_LATENCY_MS');
  }

  return config;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer, received "${raw}"`);
  }

  return parsed;
}

function readFloat(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${key} must be a number between 0 and 1, received "${raw}"`);
  }

  return parsed;
}

function readLogLevel(env: NodeJS.ProcessEnv, key: string, fallback: LogLevel): LogLevel {
  const raw = env[key];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const level = LOG_LEVELS.find((candidate) => candidate === raw);

  if (level === undefined) {
    throw new Error(`${key} must be one of ${LOG_LEVELS.join(' | ')}, received "${raw}"`);
  }

  return level;
}
