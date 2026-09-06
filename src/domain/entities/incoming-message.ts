/**
 * Mensagem recebida do WhatsApp, ja normalizada.
 *
 * E o payload que trafega na fila, entao precisa ser serializavel: apenas
 * dados, sem comportamento e sem referencia a objetos vivos. Quando a fila
 * virar um broker de verdade, este tipo e o contrato de serializacao — e o
 * motivo de ele nao carregar nada alem do necessario para responder.
 */
export interface IncomingMessage {
  /** Id atribuido pelo WhatsApp (`wamid.*`). Usado para deduplicacao e correlacao. */
  readonly messageId: string;
  /** Numero do remetente em E.164, sem `+`. Tambem e o destinatario da resposta. */
  readonly from: string;
  readonly text: string;
  /** Momento em que a Meta registrou a mensagem, nao em que a recebemos. */
  readonly receivedAt: Date;
}
