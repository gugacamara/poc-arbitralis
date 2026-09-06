import { describe, expect, it } from 'vitest';

import { MessageNotInFlightError } from '../../src/application/ports/queue.js';
import { InMemoryQueue } from '../../src/infrastructure/queue/in-memory-queue.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('InMemoryQueue', () => {
  it('entrega mensagens em ordem FIFO', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('a');
    await queue.enqueue('b');

    expect((await queue.dequeue())?.payload).toBe('a');
    expect((await queue.dequeue())?.payload).toBe('b');
  });

  it('retorna undefined quando nao ha mensagem', async () => {
    await expect(new InMemoryQueue<string>().dequeue()).resolves.toBeUndefined();
  });

  it('mantem a mensagem in-flight ate o ack, sem reentregar', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('a');

    const message = await queue.dequeue();
    expect(await queue.stats()).toEqual({ pending: 0, inFlight: 1, deadLettered: 0 });
    expect(await queue.dequeue()).toBeUndefined();

    await queue.ack(message!.id);
    expect(await queue.stats()).toEqual({ pending: 0, inFlight: 0, deadLettered: 0 });
  });

  it('rejeita — em vez de lancar — quando o ack e orfao', async () => {
    const queue = new InMemoryQueue<string>();

    // Regressao: `ack` declara Promise, entao uma excecao sincrona escaparia
    // do catch de quem faz `queue.ack(id).catch(...)`.
    const settled = queue.ack('inexistente');

    expect(settled).toBeInstanceOf(Promise);
    await expect(settled).rejects.toBeInstanceOf(MessageNotInFlightError);
  });

  it('rejeita ack duplicado', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('a');
    const message = await queue.dequeue();

    await queue.ack(message!.id);
    await expect(queue.ack(message!.id)).rejects.toBeInstanceOf(MessageNotInFlightError);
  });

  it('acumula attempts a cada reentrega apos nack', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('a');

    const first = await queue.dequeue();
    expect(first?.attempts).toBe(1);

    await queue.nack(first!.id);
    expect((await queue.dequeue())?.attempts).toBe(2);
  });

  it('respeita o backoff antes de reentregar', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('a');
    const message = await queue.dequeue();

    await queue.nack(message!.id, { retryDelayMs: 60 });
    expect(await queue.dequeue()).toBeUndefined();
    expect((await queue.stats()).pending).toBe(1);

    await sleep(80);
    expect((await queue.dequeue())?.payload).toBe('a');
  });

  it('entrega a mensagem elegivel antes da que ainda espera', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('atrasada', { delayMs: 10_000 });
    await queue.enqueue('pronta');

    // Uma mensagem em backoff nao pode bloquear a fila inteira atras de si.
    expect((await queue.dequeue())?.payload).toBe('pronta');
  });

  it('envia para a dead-letter queue, que continua reprocessavel', async () => {
    const deadLetterQueue = new InMemoryQueue<string>();
    const queue = new InMemoryQueue<string>({ deadLetterQueue });
    await queue.enqueue('veneno');

    const message = await queue.dequeue();
    await queue.nack(message!.id, { requeue: false });

    expect(await queue.stats()).toEqual({ pending: 0, inFlight: 0, deadLettered: 1 });
    expect((await deadLetterQueue.dequeue())?.payload).toBe('veneno');
  });

  it('contabiliza o descarte mesmo sem DLQ configurada', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('x');
    const message = await queue.dequeue();

    await queue.nack(message!.id, { requeue: false });
    expect((await queue.stats()).deadLettered).toBe(1);
  });

  it('entrega snapshot: mutar o retorno nao afeta o estado interno', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue('x');

    const snapshot = await queue.dequeue();
    snapshot!.enqueuedAt.setFullYear(1999);
    await queue.nack(snapshot!.id);

    expect((await queue.dequeue())!.enqueuedAt.getFullYear()).not.toBe(1999);
  });
});
