import type { FastifyInstance } from 'fastify';

import type { Logger } from '../application/ports/logger.js';
import type { LlmProvider } from '../application/ports/llm-provider.js';
import type { Queue } from '../application/ports/queue.js';
import type { WhatsAppGateway } from '../application/ports/whatsapp-gateway.js';
import { EnqueueIncomingMessages } from '../application/use-cases/enqueue-incoming-messages.js';
import { ProcessIncomingMessage } from '../application/use-cases/process-incoming-message.js';
import type { IncomingMessage } from '../domain/entities/incoming-message.js';
import { FlakyLlmProvider } from '../infrastructure/adapters/flaky-llm-provider.js';
import { SimulatedWhatsAppGateway } from '../infrastructure/adapters/simulated-whatsapp-gateway.js';
import { JsonLogger } from '../infrastructure/logging/json-logger.js';
import { InMemoryQueue } from '../infrastructure/queue/in-memory-queue.js';
import { QueueWorker } from '../infrastructure/workers/queue-worker.js';
import { WebhookController } from '../presentation/http/controllers/webhook-controller.js';
import { createServer } from '../presentation/http/server.js';
import type { AppConfig } from './config/env.js';

/**
 * Sobrescritas usadas pelos testes de integracao para trocar as dependencias
 * nao-deterministas (LLM, gateway, saida de log) sem duplicar o wiring. Em
 * producao nenhuma e informada e o padrao vale.
 */
export interface ApplicationOverrides {
  readonly logger?: Logger;
  readonly llmProvider?: LlmProvider;
  readonly whatsAppGateway?: WhatsAppGateway;
}

export interface Application {
  readonly app: FastifyInstance;
  readonly worker: QueueWorker<IncomingMessage>;
  readonly queue: Queue<IncomingMessage>;
  readonly deadLetterQueue: Queue<IncomingMessage>;
  readonly logger: Logger;
  /** Encerra HTTP e worker na ordem segura. */
  stop(): Promise<void>;
}

/**
 * Composition root: o unico lugar do sistema que conhece implementacoes
 * concretas. Todas as camadas acima dependem apenas de interfaces, e e por
 * isso que trocar `InMemoryQueue` por um adapter de SQS se resolve aqui, em
 * uma linha, sem tocar em caso de uso, worker ou controller.
 *
 * Separado do arquivo de boot para que o teste de integracao monte exatamente
 * a mesma aplicacao que roda em producao — um wiring paralelo no teste
 * validaria uma aplicacao que nao existe.
 */
export function createApplication(
  config: AppConfig,
  overrides: ApplicationOverrides = {},
): Application {
  const logger = overrides.logger ?? new JsonLogger({ level: config.logLevel });

  const deadLetterQueue = new InMemoryQueue<IncomingMessage>();
  const queue = new InMemoryQueue<IncomingMessage>({ deadLetterQueue });

  const processIncomingMessage = new ProcessIncomingMessage({
    logger,
    llmProvider:
      overrides.llmProvider ??
      new FlakyLlmProvider({
        minLatencyMs: config.llm.minLatencyMs,
        maxLatencyMs: config.llm.maxLatencyMs,
        failureRate: config.llm.failureRate,
      }),
    whatsAppGateway:
      overrides.whatsAppGateway ?? new SimulatedWhatsAppGateway({ logger }),
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

  return {
    app,
    worker,
    queue,
    deadLetterQueue,
    logger,
    stop: async () => {
      // Ordem importa: primeiro para de aceitar mensagens novas, depois drena o
      // que ja foi aceito. O inverso descartaria trabalho que a Meta considera
      // confirmado — e a promessa implicita do 202 seria quebrada.
      await app.close();
      await worker.stop();
    },
  };
}
