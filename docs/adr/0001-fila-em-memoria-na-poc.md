# ADR 0001 — Fila em memória na PoC, message broker em produção

- **Status:** Aceita
- **Data:** 2026-09-06
- **Contexto do incidente:** timeout no webhook do WhatsApp

## Contexto

O webhook recebia a mensagem e consultava o LLM **de forma síncrona**, dentro do
mesmo request HTTP. Com a degradação do LLM, a resposta passou a ultrapassar o
limite de tempo da Meta.

O modo de falha é pior do que parece à primeira vista. A Meta trata a ausência
de resposta a tempo como falha de entrega: reenvia o evento e, diante de falhas
repetidas, chega a desabilitar o webhook. Ou seja, a lentidão do LLM não causava
só latência — causava **perda de mensagem** e risco de interrupção do canal.

A causa raiz não é o LLM ser lento. É o acoplamento entre **receber** e
**processar**: dois trabalhos com requisitos de tempo incompatíveis presos ao
mesmo ciclo de vida. Receber precisa terminar em milissegundos porque o prazo é
de terceiros; processar leva segundos porque depende de um modelo. Enquanto
estiverem no mesmo request, o mais lento define o resultado.

## Decisão

Separar os dois trabalhos por uma fila, e **na PoC implementá-la em memória**,
atrás de uma interface (`Queue<T>`) que espelha o vocabulário de um broker real.

```
Meta ──POST /webhook──▶ Controller ──enqueue()──▶ 202 Accepted   (~1ms)
                                        │
                                 [ Queue<IncomingMessage> ]
                                        │
                                 QueueWorker (background)
                                        │
                            LLM (lento) ──▶ WhatsApp outbound
```

O contrato da fila inclui `enqueue`, `dequeue`, `ack`, `nack`, backoff e
dead-lettering — e é **assíncrono** (`Promise`) mesmo sendo síncrono em memória.

## Por que fila em memória nesta PoC

**A tese a provar é o desacoplamento, não a durabilidade.** A pergunta em aberto
era "responder antes de processar resolve o timeout?". Um broker real
responderia a mesma pergunta acrescentando infraestrutura, credenciais e
latência de rede ao ciclo — custo que não muda a resposta.

**Zero infraestrutura para reproduzir.** `npm install && npm run dev` sobe o
sistema completo. Uma PoC que exige subir Redis ou configurar credenciais AWS
antes da primeira execução é uma PoC que quase ninguém executa.

**Os testes ficam determinísticos e rápidos.** 103 testes em ~2 segundos, sem
container nem serviço externo. A suíte cobre retry, DLQ e timeout de forma
exata; com broker real seriam testes lentos e intermitentes.

**A troca já está isolada por construção.** O caso de uso, o worker e o
controller dependem apenas de `Queue<T>`. O único arquivo que conhece
`InMemoryQueue` é o composition root (`src/main/application.ts`).

## Consequências

### Positivas

- Ingestão desacoplada: o webhook responde em ~1ms mesmo com o LLM em 5s.
- Retry, backoff com jitter e DLQ implementados e testados.
- Nenhuma dependência externa para rodar ou testar.
- A política de retry (worker) está separada do mecanismo (fila), então trocar o
  broker não obriga a rediscutir a política.

### Negativas — e são sérias em produção

| Limitação                     | Consequência                                                        |
| ----------------------------- | ------------------------------------------------------------------- |
| Estado no heap de um processo | Restart ou crash perde o que está pendente e em voo                 |
| Sem escala horizontal         | Duas instâncias têm filas independentes, sem trabalho compartilhado |
| Sem visibilidade externa      | Só o `/health` do próprio processo enxerga a fila                   |
| Backpressure inexistente      | Uma rajada grande cresce na memória até o processo morrer           |
| Sem deduplicação              | A reentrega da Meta gera processamento repetido                     |

O shutdown gracioso reduz a primeira limitação (drena o que está em voo antes de
sair) mas **não a elimina**: um `SIGKILL` ou uma falha de hardware perdem tudo.

## Como seria em produção

### Escolha do broker

| Opção                          | Quando faz sentido                | Ressalvas                                      |
| ------------------------------ | --------------------------------- | ---------------------------------------------- |
| **Amazon SQS** _(recomendado)_ | Stack em AWS                      | Sem ordenação estrita na fila padrão           |
| **BullMQ (Redis)**             | Já existe Redis; time só de Node  | Durabilidade limitada à config do Redis        |
| **RabbitMQ**                   | On-premises, múltiplas linguagens | Cluster para operar, mais peça de infra        |
| **Kafka**                      | Já é a espinha dorsal de eventos  | Retry por mensagem e DLQ exigem trabalho extra |

**Recomendação: SQS com redrive policy.** O motivo é específico, não preferência
de marca: o modelo do SQS — _visibility timeout_, `DeleteMessage`, `maxReceiveCount`,
DLQ como fila de primeira classe — é **exatamente** o que o port `Queue<T>` já
expressa. `dequeue` vira `ReceiveMessage`, `ack` vira `DeleteMessage`, `nack`
vira `ChangeMessageVisibility`, e a DLQ deixa de ser um parâmetro do construtor
para ser uma redrive policy. A migração é escrever `SqsQueue implements Queue<T>`
e trocar uma linha no composition root.

### Estratégia de Retry

1. **Classificar antes de repetir.** A taxonomia transitório × permanente já
   existe no código. Repetir um `400` do provedor só queima tentativas; desistir
   de um `503` perde a mensagem. Em produção, mapear os códigos reais do
   provedor para essa taxonomia é a primeira tarefa.
2. **Backoff exponencial com jitter** (já implementado). O jitter é essencial:
   sem ele, todas as mensagens que falharam durante uma indisponibilidade voltam
   no mesmo instante e derrubam o upstream assim que ele se recupera.
3. **Visibility timeout maior que o pior tempo de processamento.** Se o prazo do
   broker vencer antes de o worker terminar, a mesma mensagem é entregue a outro
   consumidor e o usuário recebe resposta duplicada.
4. **Idempotência por `messageId` (`wamid`).** Toda entrega é _at-least-once_: a
   Meta reenvia, o broker reentrega e o retry repete. Sem uma chave de
   deduplicação persistida, "processar de novo" significa "responder de novo".
5. **Teto de tentativas baixo (3 a 5).** Retry existe para falha transitória;
   além disso, o problema é sistêmico e insistir só atrasa a fila.
6. **Timeout por tentativa** (já implementado), para que uma chamada travada não
   segure um slot de concorrência indefinidamente.

### Estratégia de DLQ

1. **DLQ é destino, não fim de linha.** A mensagem é preservada íntegra para
   reprocessamento após a correção — é o que separa "falhou" de "foi perdida".
2. **`maxReceiveCount` na redrive policy** define quando a mensagem migra.
3. **Alarme sobre profundidade da DLQ.** Mensagem na DLQ é sempre incidente:
   ou o upstream está fora, ou existe um bug. Qualquer valor acima de zero por
   tempo sustentado deve acionar alguém.
4. **Preservar o contexto da falha** — última exceção, número de tentativas,
   timestamps — em atributos da mensagem. Sem isso, o operador recebe uma
   mensagem sem saber por que ela falhou.
5. **Redrive controlado**, com throttling: devolver 10 mil mensagens de uma vez
   para a fila principal reproduz o incidente original.
6. **Monitorar a idade da mensagem mais antiga**, não só a contagem. Uma fila com
   100 mensagens de 2 segundos está saudável; com 5 mensagens de 40 minutos, não.

### O que mais muda

- **Deduplicação por `wamid`** antes de enfileirar, com TTL curto (Redis ou
  tabela com índice único). O ponto de extensão já está em
  `EnqueueIncomingMessages`.
- **Validação da assinatura** `X-Hub-Signature-256` da Meta, e o handshake
  `GET /webhook` com `hub.challenge`.
- **Workers em processo separado** do HTTP, para escalarem de forma
  independente: a ingestão é barata e a inferência é cara.
- **Métricas e tracing** (OpenTelemetry), com atenção redobrada para não
  reintroduzir PII nos atributos de span.

## Alternativas consideradas

**Manter síncrono e aumentar o timeout.** Não é possível: o prazo é da Meta, não
nosso.

**Responder 200 imediatamente e processar com `setImmediate`, sem fila.** É o
desacoplamento sem nenhuma das garantias: sem retry, sem visibilidade, sem
limite de concorrência e sem shutdown gracioso. Um crash perde tudo em silêncio,
e não há sequer um lugar para procurar o que se perdeu.

**Ir direto para um broker real na PoC.** Responderia a mesma pergunta com mais
custo de setup, tornaria a reprodução dependente de infraestrutura e deixaria os
testes lentos e intermitentes. A abstração adotada permite fazer essa migração
depois, quando ela passa a resolver um problema real — durabilidade e escala —
em vez de antecipar complexidade.
