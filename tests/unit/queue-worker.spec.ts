import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NackOptions } from '../../src/application/ports/queue.js';
import {
  PermanentIntegrationError,
  TransientIntegrationError,
} from '../../src/domain/errors/integration-error.js';
import { InMemoryQueue } from '../../src/infrastructure/queue/in-memory-queue.js';
import { QueueWorker } from '../../src/infrastructure/workers/queue-worker.js';
import { createRecordingLogger, createSilentLogger, until } from '../support/fakes.js';

const workers: QueueWorker<string>[] = [];

/** Cria um worker ja registrado para parada automatica ao fim do teste. */
function createWorker(
  options: Omit<ConstructorParameters<typeof QueueWorker<string>>[0], 'logger'> & {
    logger?: ReturnType<typeof createSilentLogger>;
  },
): QueueWorker<string> {
  const worker = new QueueWorker<string>({
    logger: options.logger ?? createSilentLogger(),
    concurrency: 1,
    idlePollIntervalMs: 1,
    retryBaseDelayMs: 1,
    random: () => 0,
    ...options,
  });

  workers.push(worker);
  return worker;
}

afterEach(async () => {
  // Um worker sobrevivente vazaria entre testes e tornaria a suite instavel.
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

describe('QueueWorker — caminho feliz', () => {
  it('drena a fila e confirma cada mensagem', async () => {
    const queue = new InMemoryQueue<string>();
    const handled: string[] = [];
    const worker = createWorker({
      queue,
      concurrency: 2,
      handler: async (payload) => {
        handled.push(payload);
      },
    });

    await queue.enqueue('a');
    await queue.enqueue('b');
    await queue.enqueue('c');
    worker.start();

    await until(() => handled.length === 3, 'processar as 3 mensagens');

    expect(handled.toSorted()).toEqual(['a', 'b', 'c']);
    expect(await queue.stats()).toEqual({ pending: 0, inFlight: 0, deadLettered: 0 });
    expect(worker.stats().processed).toBe(3);
  });

  it('ignora start duplicado em vez de dobrar a concorrencia', async () => {
    const queue = new InMemoryQueue<string>();
    const worker = createWorker({ queue, handler: async () => undefined });

    worker.start();
    worker.start();

    expect(worker.stats().running).toBe(true);
  });
});

describe('QueueWorker — falhas do LLM', () => {
  it('repete a falha transitoria ate obter sucesso, sem perder a mensagem', async () => {
    const queue = new InMemoryQueue<string>();
    let attempts = 0;
    const worker = createWorker({
      queue,
      maxAttempts: 5,
      handler: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new TransientIntegrationError('LLM temporarily unavailable (503)');
        }
      },
    });

    await queue.enqueue('mensagem');
    worker.start();

    await until(() => worker.stats().processed === 1, 'suceder apos as tentativas');

    expect(attempts).toBe(3);
    expect(worker.stats().retried).toBe(2);
    expect((await queue.stats()).deadLettered).toBe(0);
  });

  it('envia para a DLQ ao esgotar as tentativas, preservando a mensagem', async () => {
    const deadLetterQueue = new InMemoryQueue<string>();
    const queue = new InMemoryQueue<string>({ deadLetterQueue });
    let attempts = 0;
    const worker = createWorker({
      queue,
      maxAttempts: 3,
      handler: async () => {
        attempts += 1;
        throw new TransientIntegrationError('LLM upstream timed out');
      },
    });

    await queue.enqueue('sempre-falha');
    worker.start();

    await until(() => worker.stats().deadLettered === 1, 'cair na DLQ');

    expect(attempts).toBe(3);
    // A mensagem nao se perde: fica recuperavel para reprocessamento.
    expect((await deadLetterQueue.dequeue())?.payload).toBe('sempre-falha');
  });

  it('manda falha permanente direto para a DLQ, sem gastar tentativas', async () => {
    const queue = new InMemoryQueue<string>();
    let attempts = 0;
    const worker = createWorker({
      queue,
      maxAttempts: 5,
      handler: async () => {
        attempts += 1;
        throw new PermanentIntegrationError('LLM rejected the request (400)');
      },
    });

    await queue.enqueue('invalida');
    worker.start();

    await until(() => worker.stats().deadLettered === 1, 'DLQ imediata');

    expect(attempts).toBe(1);
    expect(worker.stats().retried).toBe(0);
  });

  it('aplica backoff exponencial entre as tentativas', async () => {
    const queue = new InMemoryQueue<string>();
    const delays: number[] = [];
    const nack = queue.nack.bind(queue);
    queue.nack = async (id: string, options?: NackOptions) => {
      if (options?.retryDelayMs !== undefined) {
        delays.push(options.retryDelayMs);
      }
      return nack(id, options);
    };

    const worker = createWorker({
      queue,
      maxAttempts: 4,
      retryBaseDelayMs: 100,
      random: () => 1,
      handler: async () => {
        throw new TransientIntegrationError('falha');
      },
    });

    await queue.enqueue('y');
    worker.start();

    await until(() => worker.stats().deadLettered === 1, 'esgotar as tentativas');

    expect(delays).toEqual([100, 200, 400]);
  });

  it('aplica jitter para nao sincronizar a volta das mensagens em falha', async () => {
    const queue = new InMemoryQueue<string>();
    const delays: number[] = [];
    const nack = queue.nack.bind(queue);
    queue.nack = async (id: string, options?: NackOptions) => {
      if (options?.retryDelayMs !== undefined) {
        delays.push(options.retryDelayMs);
      }
      return nack(id, options);
    };

    const worker = createWorker({
      queue,
      maxAttempts: 2,
      retryBaseDelayMs: 1_000,
      random: () => 0, // piso do jitter
      handler: async () => {
        throw new TransientIntegrationError('falha');
      },
    });

    await queue.enqueue('y');
    worker.start();

    await until(() => worker.stats().deadLettered === 1, 'esgotar as tentativas');

    // Sem jitter o valor seria exatamente 1000 para todas as mensagens.
    expect(delays[0]).toBe(500);
  });

  it('registra o erro sem vazar PII ao agendar novo retry', async () => {
    const recording = createRecordingLogger();
    const queue = new InMemoryQueue<string>();
    const worker = createWorker({
      queue,
      logger: recording.logger,
      maxAttempts: 2,
      handler: async () => {
        throw new TransientIntegrationError('falha ao responder 5521999998888');
      },
    });

    await queue.enqueue('y');
    worker.start();

    await until(() => worker.stats().deadLettered === 1, 'esgotar as tentativas');

    expect(recording.raw()).not.toContain('5521999998888');
    expect(recording.raw()).toContain('55*******8888');
  });
});

describe('QueueWorker — resiliencia', () => {
  it('libera o slot e reagenda quando o handler ignora o timeout', async () => {
    const queue = new InMemoryQueue<string>();
    let aborted = false;
    const worker = createWorker({
      queue,
      handlerTimeoutMs: 20,
      maxAttempts: 2,
      handler: async (_payload, { signal }) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        // Ignora o abort de proposito: JS nao mata promise, e o worker precisa
        // liberar o slot mesmo assim.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      },
    });

    await queue.enqueue('travada');
    worker.start();

    await until(() => worker.stats().retried >= 1, 'timeout disparar o retry');

    expect(aborted).toBe(true);
  });

  it('mantem o loop vivo quando a liquidacao da mensagem falha', async () => {
    const queue = new InMemoryQueue<string>();
    const handled: string[] = [];
    let firstNack = true;
    queue.nack = async () => {
      if (firstNack) {
        firstNack = false;
        throw new Error('falha ao liquidar');
      }
    };

    const worker = createWorker({
      queue,
      handler: async (payload) => {
        handled.push(payload);
        if (payload === 'quebra') {
          throw new TransientIntegrationError('falha');
        }
      },
    });

    await queue.enqueue('quebra');
    await queue.enqueue('seguinte');
    worker.start();

    // Um worker que morre em silencio leva junto todas as proximas mensagens.
    await until(() => handled.includes('seguinte'), 'seguir consumindo apos o erro');
  });

  it('aguarda o trabalho em andamento ao parar', async () => {
    const queue = new InMemoryQueue<string>();
    let started = false;
    let finished = false;
    const worker = createWorker({
      queue,
      handler: async () => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        finished = true;
      },
    });

    await queue.enqueue('em-voo');
    worker.start();
    await until(() => started, 'o handler comecar a processar');

    // Para com a mensagem comprovadamente em voo, nao antes de o consumo comecar.
    expect(finished).toBe(false);
    await worker.stop();

    expect(finished).toBe(true);
    expect(worker.stats().processed).toBe(1);
  });

  it('encerra rapidamente quando a fila esta ociosa', async () => {
    const worker = createWorker({
      queue: new InMemoryQueue<string>(),
      idlePollIntervalMs: 5_000,
      handler: async () => undefined,
    });

    worker.start();
    const startedAt = Date.now();
    await worker.stop();

    // O stop aborta a espera ociosa em vez de aguardar o ciclo inteiro.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
