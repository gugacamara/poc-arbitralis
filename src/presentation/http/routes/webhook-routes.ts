import type { FastifyInstance } from 'fastify';

import type { WebhookController } from '../controllers/webhook-controller.js';
import {
  metaWebhookBodySchema,
  webhookAcceptedResponseSchema,
} from '../meta-webhook-payload.js';

export interface WebhookRoutesOptions {
  readonly webhookController: WebhookController;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  options: WebhookRoutesOptions,
): void {
  app.post(
    '/webhook',
    {
      schema: {
        body: metaWebhookBodySchema,
        response: { 202: webhookAcceptedResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await options.webhookController.handle(request.body);
      await reply.status(result.status).send(result.body);
    },
  );
}
