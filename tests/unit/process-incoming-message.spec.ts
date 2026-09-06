import { describe, expect, it, vi } from 'vitest';

import type { LlmProvider } from '../../src/application/ports/llm-provider.js';
import type { WhatsAppGateway } from '../../src/application/ports/whatsapp-gateway.js';
import { ProcessIncomingMessage } from '../../src/application/use-cases/process-incoming-message.js';
import type { IncomingMessage } from '../../src/domain/entities/incoming-message.js';
import { TransientIntegrationError } from '../../src/domain/errors/integration-error.js';
import { createRecordingLogger } from '../support/fakes.js';

const message: IncomingMessage = {
  messageId: 'wamid.1',
  from: '5521999998888',
  text: 'Qual o status do meu processo?',
  receivedAt: new Date('2026-01-15T09:59:00.000Z'),
};

function createGateway(): WhatsAppGateway {
  return {
    sendText: vi.fn().mockResolvedValue({
      externalId: 'wamid.mock-1',
      sentAt: new Date('2026-01-15T10:00:00.000Z'),
    }),
  };
}

function createLlm(text = 'Ja estou verificando.'): LlmProvider {
  return {
    complete: vi.fn().mockResolvedValue({ text, model: 'mock-llm-v1', latencyMs: 4_771 }),
  };
}

describe('ProcessIncomingMessage', () => {
  it('consulta o LLM e responde ao remetente', async () => {
    const llmProvider = createLlm();
    const whatsAppGateway = createGateway();
    const { logger } = createRecordingLogger();

    await new ProcessIncomingMessage({ llmProvider, whatsAppGateway, logger }).execute(
      message,
    );

    expect(llmProvider.complete).toHaveBeenCalledWith(
      { conversationId: '5521999998888', prompt: 'Qual o status do meu processo?' },
      {},
    );
    expect(whatsAppGateway.sendText).toHaveBeenCalledWith(
      {
        to: '5521999998888',
        text: 'Ja estou verificando.',
        replyToMessageId: 'wamid.1',
      },
      {},
    );
  });

  it('propaga o AbortSignal para os dois adapters', async () => {
    const llmProvider = createLlm();
    const whatsAppGateway = createGateway();
    const { logger } = createRecordingLogger();
    const { signal } = new AbortController();

    await new ProcessIncomingMessage({ llmProvider, whatsAppGateway, logger }).execute(
      message,
      { signal },
    );

    expect(llmProvider.complete).toHaveBeenCalledWith(expect.anything(), { signal });
    expect(whatsAppGateway.sendText).toHaveBeenCalledWith(expect.anything(), { signal });
  });

  it('nao envia resposta quando o LLM falha', async () => {
    const whatsAppGateway = createGateway();
    const { logger } = createRecordingLogger();
    const llmProvider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new TransientIntegrationError('LLM 503')),
    };

    const useCase = new ProcessIncomingMessage({ llmProvider, whatsAppGateway, logger });

    // Falha alto: decidir sobre nova tentativa e responsabilidade do worker.
    await expect(useCase.execute(message)).rejects.toBeInstanceOf(
      TransientIntegrationError,
    );
    expect(whatsAppGateway.sendText).not.toHaveBeenCalled();
  });

  it('propaga falha do envio, para que a tentativa inteira seja repetida', async () => {
    const { logger } = createRecordingLogger();
    const whatsAppGateway: WhatsAppGateway = {
      sendText: vi.fn().mockRejectedValue(new TransientIntegrationError('WhatsApp 503')),
    };

    const useCase = new ProcessIncomingMessage({
      llmProvider: createLlm(),
      whatsAppGateway,
      logger,
    });

    await expect(useCase.execute(message)).rejects.toBeInstanceOf(
      TransientIntegrationError,
    );
  });

  it('registra a latencia do LLM sem vazar dados do contato', async () => {
    const recording = createRecordingLogger();

    await new ProcessIncomingMessage({
      llmProvider: createLlm(),
      whatsAppGateway: createGateway(),
      logger: recording.logger,
    }).execute(message);

    expect(recording.entries()[0]).toMatchObject({
      message: 'llm replied',
      llmLatencyMs: 4_771,
      messageId: 'wamid.1',
    });
    expect(recording.raw()).not.toContain('5521999998888');
    expect(recording.raw()).not.toContain('Qual o status do meu processo');
  });
});
