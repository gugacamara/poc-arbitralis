import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { Logger } from '../../application/ports/logger.js';
import type { WebhookController } from './controllers/webhook-controller.js';
import { registerHealthRoutes, type HealthReport } from './routes/health-routes.js';
import { registerWebhookRoutes } from './routes/webhook-routes.js';

export interface ServerDependencies {
  readonly webhookController: WebhookController;
  readonly logger: Logger;
  readonly healthReport: () => Promise<HealthReport>;
}

export function createServer(dependencies: ServerDependencies): FastifyInstance {
  // O logger embutido do Fastify fica desligado de proposito: ele registra
  // requisicoes e erros sem passar pelo mascarador de PII, o que abriria um
  // caminho paralelo ate stdout justamente no ponto onde o payload chega. Todo
  // log da aplicacao passa pelo nosso Logger.
  const app = Fastify({ logger: false });

  registerWebhookRoutes(app, { webhookController: dependencies.webhookController });
  registerHealthRoutes(app, { report: dependencies.healthReport });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    const context = { method: request.method, url: request.url, status, error };

    // 4xx e erro do cliente (schema invalido) e nao merece nivel error: alertar
    // sobre payload malformado de terceiro so ensina o time a ignorar alertas.
    if (status >= 500) {
      dependencies.logger.error('request failed', context);
    } else {
      dependencies.logger.warn('request rejected', context);
    }

    // A mensagem interna nao volta ao cliente: pode conter detalhe de upstream.
    void reply.status(status).send({
      status: 'error',
      message: status >= 500 ? 'Internal Server Error' : error.message,
    });
  });

  return app;
}
