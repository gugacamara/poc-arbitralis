import type { LogContext, Logger, LogLevel } from '../../application/ports/logger.js';
import { maskContext, maskText } from './pii-masker.js';

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Campos que o logger controla e que o contexto nao pode sobrescrever. */
interface LogEntry extends Record<string, unknown> {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface JsonLoggerOptions {
  /** Entradas abaixo deste nivel sao descartadas. Padrao: `info`. */
  readonly level?: LogLevel;
  readonly bindings?: LogContext;
  /** Injetavel para teste: evita capturar stdout do processo. */
  readonly write?: (line: string) => void;
  /** Injetavel para teste: torna o timestamp deterministico. */
  readonly now?: () => Date;
}

/**
 * Logger estruturado em NDJSON, com mascaramento de PII obrigatorio.
 *
 * O mascaramento acontece *dentro* do logger, e nao na chamada, de proposito:
 * confiar que todo autor lembrara de mascarar antes de logar e uma politica
 * que falha na primeira pressa. Aqui, esquecer e impossivel — nao ha caminho
 * ate a saida que nao passe pelo mascarador. A regra `no-console` do ESLint
 * fecha o cerco, impedindo que alguem contorne o logger com `console.log`.
 *
 * Sai tudo em stdout (12-factor: log e stream de eventos; separar por
 * severidade e trabalho do coletor, nao da aplicacao).
 */
export class JsonLogger implements Logger {
  readonly #level: LogLevel;
  readonly #bindings: LogContext;
  readonly #write: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: JsonLoggerOptions = {}) {
    this.#level = options.level ?? 'info';
    this.#bindings = options.bindings ?? {};
    this.#write = options.write ?? writeToStdout;
    this.#now = options.now ?? (() => new Date());
  }

  debug(message: string, context?: LogContext): void {
    this.#log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.#log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.#log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.#log('error', message, context);
  }

  child(bindings: LogContext): Logger {
    return new JsonLogger({
      level: this.#level,
      bindings: { ...this.#bindings, ...bindings },
      write: this.#write,
      now: this.#now,
    });
  }

  #log(level: LogLevel, message: string, context: LogContext = {}): void {
    if (SEVERITY[level] < SEVERITY[this.#level]) {
      return;
    }

    const entry: LogEntry = {
      // Contexto primeiro: os campos reservados abaixo sempre vencem, para que
      // um payload externo com `level` ou `timestamp` nao corrompa a entrada.
      ...maskContext({ ...this.#bindings, ...context }),
      timestamp: this.#now().toISOString(),
      level,
      // A propria mensagem passa pelo mascarador: interpolar um telefone direto
      // no texto e o jeito mais facil de vazar PII sem perceber.
      message: maskText(message),
    };

    this.#write(`${JSON.stringify(entry)}\n`);
  }
}

function writeToStdout(line: string): void {
  process.stdout.write(line);
}
