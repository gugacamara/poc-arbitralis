/** Contrato do provedor de LLM exigido pela camada de aplicacao. */

export interface LlmRequest {
  /** Correlaciona a chamada com a conversa, sem carregar dados do contato. */
  readonly conversationId: string;
  readonly prompt: string;
}

export interface LlmReply {
  readonly text: string;
  readonly model: string;
  /** Latencia observada da chamada. E a metrica central do incidente. */
  readonly latencyMs: number;
}

export interface LlmCallOptions {
  /**
   * Cancela a chamada em andamento.
   *
   * Sem cancelamento, uma chamada travada segura um slot de concorrencia do
   * worker indefinidamente: o timeout sincrono da Meta viraria um vazamento de
   * capacidade no processamento assincrono — o mesmo problema, so que mais
   * dificil de enxergar.
   */
  readonly signal?: AbortSignal;
}

export interface LlmProvider {
  complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmReply>;
}
