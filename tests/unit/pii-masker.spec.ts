import { describe, expect, it } from 'vitest';

import {
  maskContext,
  maskEmail,
  maskName,
  maskPhone,
  maskText,
} from '../../src/infrastructure/logging/pii-masker.js';
import { buildTextMessagePayload } from '../support/meta-payload.js';

describe('maskPhone', () => {
  it('preserva prefixo do pais e os 4 ultimos digitos', () => {
    expect(maskPhone('5521999998888')).toBe('55*******8888');
  });

  it('normaliza separadores antes de mascarar', () => {
    expect(maskPhone('+55 (21) 99999-8888')).toBe('55*******8888');
  });

  it('mascara por completo o que e curto demais para identificar', () => {
    expect(maskPhone('1234')).toBe('****');
  });
});

describe('maskName', () => {
  it('reduz cada termo a inicial, preservando a quantidade de termos', () => {
    expect(maskName('João da Silva')).toBe('J*** d*** S***');
  });

  it('nao expoe inicial de termo de uma letra so', () => {
    expect(maskName('J P')).toBe('* *');
  });
});

describe('maskEmail', () => {
  it('preserva o dominio, que ajuda no diagnostico sem identificar', () => {
    expect(maskEmail('joao.silva@empresa.com.br')).toBe('j***@empresa.com.br');
  });

  it('nao vaza nada quando o valor nao parece e-mail', () => {
    expect(maskEmail('sem-arroba')).toBe('***');
  });
});

describe('maskText', () => {
  it.each([
    ['telefone isolado', '5521999998888', '55*******8888'],
    ['telefone em frase', 'ligue 5521999998888 hoje', 'ligue 55*******8888 hoje'],
    ['telefone formatado', '+55 21 99999-8888', '55*******8888'],
    ['e-mail', 'joao@empresa.com.br', 'j***@empresa.com.br'],
    ['CPF', '123.456.789-01', '***.***.***-01'],
  ])('mascara %s', (_label, input, expected) => {
    expect(maskText(input)).toBe(expected);
  });

  // Regressao: a regex de telefone casava dentro de identificadores e destruia
  // os campos de correlacao — justamente o que o log existe para preservar.
  it.each([
    ['UUID', '27725b8e-8064-0338-a37a-b1a8e679a93'],
    ['wamid', 'wamid.mock-78a15e2c-bd3e-4042-a69b-b9b3b2146fdf'],
    ['timestamp ISO', '2026-09-06T20:48:54.343Z'],
    ['id curto', 'phone_number_id 109'],
  ])('preserva %s intacto', (_label, input) => {
    expect(maskText(input)).toBe(input);
  });
});

describe('maskContext', () => {
  it('mascara por nome de campo, unica forma de detectar nome proprio', () => {
    expect(maskContext({ profileName: 'João da Silva', wa_id: '5521999998888' })).toEqual(
      {
        profileName: 'J*** d*** S***',
        wa_id: '55*******8888',
      },
    );
  });

  it('mascara telefone que chega como numero', () => {
    expect(maskContext({ phone: 5521999998888 })).toEqual({ phone: '55*******8888' });
  });

  it('redige o corpo da mensagem preservando apenas o tamanho', () => {
    expect(maskContext({ text: 'meu endereco e rua tal, 42' })).toEqual({
      text: '[redacted:26 chars]',
    });
  });

  it('remove segredos por completo, sem pista parcial', () => {
    expect(maskContext({ authorization: 'Bearer eyJhbGciOi' })).toEqual({
      authorization: '[redacted]',
    });
  });

  it('preserva campos que nao sao PII', () => {
    expect(maskContext({ latencyMs: 4771, model: 'mock-llm-v1' })).toEqual({
      latencyMs: 4771,
      model: 'mock-llm-v1',
    });
  });

  it('mascara Error sem perder o tipo', () => {
    expect(
      maskContext({ error: new Error('falha ao ligar para 5521999998888') }),
    ).toEqual({
      error: { name: 'Error', message: 'falha ao ligar para 55*******8888' },
    });
  });

  it('trata payload ciclico sem estourar a pilha', () => {
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic['self'] = cyclic;

    expect(maskContext({ cyclic })).toEqual({ cyclic: { id: 'x', self: '[circular]' } });
  });

  it('trunca aninhamento excessivo em vez de recorrer sem limite', () => {
    let deep: Record<string, unknown> = { value: 'fundo' };
    for (let i = 0; i < 20; i++) {
      deep = { nested: deep };
    }

    expect(JSON.stringify(maskContext(deep))).toContain('[truncated]');
  });

  it('nao deixa escapar nenhum dado sensivel de um payload real da Meta', () => {
    const masked = JSON.stringify(maskContext({ payload: buildTextMessagePayload() }));

    for (const secret of [
      '5521999998888',
      '5511988887777',
      'João da Silva',
      'Qual o status do meu processo',
    ]) {
      expect(masked).not.toContain(secret);
    }

    // Utilidade preservada: identificadores que nao sao PII sobrevivem.
    expect(masked).toContain('wamid.TEST0');
    expect(masked).toContain('109');
  });
});
