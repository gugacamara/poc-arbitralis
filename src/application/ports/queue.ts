/**
 * Contrato de fila exigido pela camada de aplicacao.
 *
 * O vocabulario (enqueue / dequeue / ack / nack / dead-letter) foi escolhido
 * deliberadamente para espelhar o de um message broker real. Trocar a
 * implementacao em memoria por SQS, RabbitMQ ou BullMQ deve custar apenas um
 * novo adapter e uma linha no composition root — nenhum caso de uso muda.
 */

/** Mensagem entregue a um consumidor. Snapshot imutavel do estado interno. */
export interface QueueMessage<TPayload> {
  readonly id: string;
  readonly payload: TPayload;
  /** Quantas vezes esta mensagem ja foi entregue a um consumidor. */
  readonly attempts: number;
  readonly enqueuedAt: Date;
  /** Antes deste instante a mensagem nao e elegivel para consumo (backoff). */
  readonly availableAt: Date;
}

export interface EnqueueOptions {
  /** Atrasa a primeira entrega. Equivale ao DelaySeconds do SQS. */
  readonly delayMs?: number;
}

export interface NackOptions {
  /** `false` envia a mensagem para a dead-letter queue. Padrao: `true`. */
  readonly requeue?: boolean;
  /** Backoff antes da proxima tentativa. Ignorado quando `requeue` e `false`. */
  readonly retryDelayMs?: number;
}

export interface QueueStats {
  /** Aguardando consumo (inclui mensagens ainda em backoff). */
  readonly pending: number;
  /** Entregues e ainda sem ack/nack. */
  readonly inFlight: number;
  /** Descartadas para a dead-letter queue desde o inicio do processo. */
  readonly deadLettered: number;
}

export interface Queue<TPayload> {
  /**
   * Registra a mensagem para processamento futuro. Retorna assim que ela esta
   * durabilizada no backend da fila — nunca aguarda o processamento.
   */
  enqueue(payload: TPayload, options?: EnqueueOptions): Promise<QueueMessage<TPayload>>;

  /**
   * Retira a proxima mensagem elegivel e a marca como in-flight. Ate receber
   * `ack` ou `nack` ela nao volta a ser entregue.
   *
   * Retorna `undefined` quando nao ha mensagem elegivel — inclusive quando ha
   * mensagens pendentes mas todas ainda em backoff.
   */
  dequeue(): Promise<QueueMessage<TPayload> | undefined>;

  /** Confirma o processamento e remove a mensagem definitivamente. */
  ack(messageId: string): Promise<void>;

  /** Devolve a mensagem para a fila (com backoff opcional) ou a envia para a DLQ. */
  nack(messageId: string, options?: NackOptions): Promise<void>;

  stats(): Promise<QueueStats>;
}

/**
 * Lancado por `ack`/`nack` quando o id nao corresponde a uma mensagem in-flight
 * — sintoma de ack duplicado ou de id forjado pelo consumidor.
 */
export class MessageNotInFlightError extends Error {
  constructor(readonly messageId: string) {
    super(`Message "${messageId}" is not in flight`);
    this.name = 'MessageNotInFlightError';
  }
}
