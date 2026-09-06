import { describe, expect, it } from 'vitest';

import { JsonLogger } from '../../src/infrastructure/logging/json-logger.js';
import { createRecordingLogger } from '../support/fakes.js';

describe('JsonLogger', () => {
  it('emite NDJSON com os campos reservados', () => {
    const { logger, lines, entries } = createRecordingLogger();
    logger.info('webhook accepted', { accepted: 1 });

    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(entries()[0]).toEqual({
      timestamp: '2026-01-15T10:00:00.000Z',
      level: 'info',
      message: 'webhook accepted',
      accepted: 1,
    });
  });

  it('mascara PII interpolada na propria mensagem', () => {
    const { logger, raw } = createRecordingLogger();

    // O jeito mais facil de vazar PII e escrever o telefone direto no texto.
    logger.warn('falha ao responder 5521999998888');

    expect(raw()).not.toContain('5521999998888');
    expect(raw()).toContain('55*******8888');
  });

  it('impede que o contexto sobrescreva os campos reservados', () => {
    const { logger, entries } = createRecordingLogger();

    // Payload externo nao pode forjar entrada de log rebaixando a severidade.
    logger.error('ataque', { level: 'debug', timestamp: 'falsificado' });

    expect(entries()[0]).toMatchObject({
      level: 'error',
      timestamp: '2026-01-15T10:00:00.000Z',
    });
  });

  it('descarta entradas abaixo do nivel configurado', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ level: 'warn', write: (line) => lines.push(line) });

    logger.debug('nao');
    logger.info('nao');
    logger.warn('sim');
    logger.error('sim');

    expect(lines).toHaveLength(2);
  });

  it('propaga bindings do child em toda entrada', () => {
    const { logger, entries } = createRecordingLogger();
    const child = logger.child({ messageId: 'wamid.1' });

    child.info('primeira');
    child.info('segunda');

    expect(entries().every((entry) => entry['messageId'] === 'wamid.1')).toBe(true);
  });

  it('mascara PII vinda dos bindings do child', () => {
    const { logger, raw } = createRecordingLogger();

    logger.child({ from: '5521999998888' }).info('processando');

    expect(raw()).not.toContain('5521999998888');
  });

  it('nao afeta o logger pai ao derivar um child', () => {
    const { logger, entries } = createRecordingLogger();

    logger.child({ scoped: true }).info('do child');
    logger.info('do pai');

    expect(entries()[1]).not.toHaveProperty('scoped');
  });
});
