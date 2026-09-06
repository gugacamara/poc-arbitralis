/**
 * Vocabulario compartilhado para falhas de integracao externa.
 *
 * A distincao entre transitorio e permanente e o que torna a politica de retry
 * do worker uma decisao informada em vez de um chute. Sem ela so restam dois
 * comportamentos ruins: repetir o que nunca vai funcionar (queimando
 * tentativas e atrasando a fila) ou desistir do que so precisava de mais uma
 * chance (perdendo a mensagem — exatamente o incidente que a PoC resolve).
 */
export abstract class IntegrationError extends Error {
  /** `true` quando repetir a mesma chamada tem chance real de sucesso. */
  abstract readonly retryable: boolean;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Timeout, rate limit, indisponibilidade momentanea. Vale tentar de novo. */
export class TransientIntegrationError extends IntegrationError {
  readonly retryable = true;
}

/** Payload invalido, credencial revogada, recurso inexistente. Repetir so gasta tempo. */
export class PermanentIntegrationError extends IntegrationError {
  readonly retryable = false;
}

/**
 * Classifica qualquer erro para a politica de retry.
 *
 * Erro desconhecido e tratado como transitorio de proposito: pode ser uma
 * falha de rede ainda nao mapeada, e desistir dele perderia a mensagem. O
 * limite de tentativas do worker impede que um bug determinista (um TypeError,
 * digamos) fique repetindo para sempre — ele acaba na DLQ, onde e visivel.
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof IntegrationError ? error.retryable : true;
}
