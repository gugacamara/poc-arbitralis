import type { FastifyInstance } from 'fastify';

import type { QueueStats } from '../../../application/ports/queue.js';
import type { WorkerStats } from '../../../infrastructure/workers/queue-worker.js';

export interface HealthReport {
  readonly status: 'ok';
  readonly queue: QueueStats;
  readonly deadLetterQueue: QueueStats;
  readonly worker: WorkerStats;
}

export interface HealthRoutesOptions {
  readonly report: () => Promise<HealthReport>;
}

/**
 * Expoe o estado da fila e do worker.
 *
 * Num sistema assincrono, "o servidor responde" nao significa "as mensagens
 * estao sendo processadas": o webhook pode devolver 202 normalmente enquanto o
 * worker esta parado e a fila so cresce. Este endpoint torna esse
 * descolamento visivel — e e como o README demonstra o fluxo funcionando.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions,
): void {
  app.get('/health', async (_request, reply) => {
    await reply.status(200).send(await options.report());
  });
}
