import type { LogContext, Logger } from '../../src/application/ports/logger.js';
import { JsonLogger } from '../../src/infrastructure/logging/json-logger.js';

/** Logger que guarda as linhas emitidas, para assertar sobre o que foi logado. */
export interface RecordingLogger {
  readonly logger: Logger;
  readonly lines: string[];
  entries(): Record<string, unknown>[];
  /** Concatena tudo, para checar que um dado sensivel nao aparece em lugar algum. */
  raw(): string;
}

export function createRecordingLogger(): RecordingLogger {
  const lines: string[] = [];

  return {
    lines,
    logger: new JsonLogger({
      level: 'debug',
      write: (line) => lines.push(line),
      now: () => new Date('2026-01-15T10:00:00.000Z'),
    }),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(''),
  };
}

export function createSilentLogger(): Logger {
  return new JsonLogger({ level: 'error', write: () => undefined });
}

/**
 * Sorteio deterministico: consome a sequencia e depois repete o ultimo valor.
 * Substitui `Math.random` nos adapters para que cada ramo seja testavel.
 */
export function seededRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

/** Sleep instantaneo: mantem a suite rapida sem depender de fake timers. */
export const instantSleep = async (): Promise<void> => {
  await Promise.resolve();
};

/**
 * Aguarda uma condicao ficar verdadeira.
 *
 * O worker roda em loops proprios, entao o teste nao tem uma promise para
 * aguardar — precisa observar o efeito. O limite evita que uma regressao
 * trave a suite indefinidamente.
 */
export async function until(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`Timeout aguardando: ${description}`);
}

export function buildLogContext(overrides: LogContext = {}): LogContext {
  return { requestId: 'req-1', ...overrides };
}
