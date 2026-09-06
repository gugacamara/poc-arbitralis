import type { IncomingMessage } from '../domain/entities/incoming-message.js';
import { EnqueueIncomingMessages } from '../application/use-cases/enqueue-incoming-messages.js';
import { ProcessIncomingMessage } from '../application/use-cases/process-incoming-message.js';
import { FlakyLlmProvider } from '../infrastructure/adapters/flaky-llm-provider.js';
import { SimulatedWhatsAppGateway } from '../infrastructure/adapters/simulated-whatsapp-gateway.js';
import { JsonLogger } from '../infrastructure/logging/json-logger.js';
import { InMemoryQueue } from '../infrastructure/queue/in-memory-queue.js';
import { QueueWorker } from '../infrastructure/workers/queue-worker.js';
import { WebhookController } from '../presentation/http/controllers/webhook-controller.js';
import { createServer } from '../presentation/http/server.js';
import { loadConfig } from './config/env.js';

/**
 * Composition root: o unico lugar do sistema que conhece implementacoes
 * concretas. Todas as camadas acima dependem apenas de interfaces, e e por
 * isso que trocar `InMemoryQueue` por um adapter de SQS se resolve aqui, em
 * uma linha, sem tocar em caso de uso, worker ou controller.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger({ level: config.logLevel });

  const deadLetterQueue = new InMemoryQueue<IncomingMessage>();
  const queue = new InMemoryQueue<IncomingMessage>({ deadLetterQueue });

  const processIncomingMessage = new ProcessIncomingMessage({
    logger,
    llmProvider: new FlakyLlmProvider({
      minLatencyMs: config.llm.minLatencyMs,
      maxLatencyMs: config.llm.maxLatencyMs,
      failureRate: config.llm.failureRate,
    }),
    whatsAppGateway: new SimulatedWhatsAppGateway({ logger }),
  });

  const worker = new QueueWorker<IncomingMessage>({
    queue,
    logger,
    concurrency: config.worker.concurrency,
    maxAttempts: config.worker.maxAttempts,
    retryBaseDelayMs: config.worker.retryBaseDelayMs,
    handlerTimeoutMs: config.worker.handlerTimeoutMs,
    handler: (payload, context) => processIncomingMessage.execute(payload, context),
  });

  const app = createServer({
    logger,
    webhookController: new WebhookController({
      logger,
      enqueueIncomingMessages: new EnqueueIncomingMessages({ queue, logger }),
    }),
    healthReport: async () => ({
      status: 'ok' as const,
      queue: await queue.stats(),
      deadLetterQueue: await deadLetterQueue.stats(),
      worker: worker.stats(),
    }),
  });

  worker.start();
  await app.listen({ port: config.http.port, host: config.http.host });

  logger.info('server listening', { port: config.http.port, host: config.http.host });

  registerShutdownHandlers(async () => {
    // Ordem importa: primeiro para de aceitar mensagens novas, depois drena o
    // que ja foi aceito. O inverso descartaria trabalho que a Meta considera
    // confirmado — e a promessa implicita do 202 seria quebrada.
    logger.info('shutdown requested');
    await app.close();
    await worker.stop();
  });
}

function registerShutdownHandlers(shutdown: () => Promise<void>): void {
  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

await main();
