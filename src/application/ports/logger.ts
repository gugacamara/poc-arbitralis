/**
 * Contrato de logging exigido pela camada de aplicacao.
 *
 * Casos de uso e workers dependem desta interface, nunca de uma lib concreta.
 * Trocar stdout por Pino, Datadog ou OpenTelemetry e um novo adapter.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Campos estruturados que acompanham a mensagem. Passam pelo mascarador de PII. */
export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;

  /**
   * Deriva um logger que carrega `bindings` em toda entrada.
   *
   * E o que permite correlacionar o ciclo de vida de uma mensagem: o worker
   * cria um child com `{ messageId }` e todo log daquele processamento fica
   * rastreavel sem repetir o campo em cada chamada.
   */
  child(bindings: LogContext): Logger;
}
