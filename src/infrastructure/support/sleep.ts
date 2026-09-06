import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * Espera cancelavel, usada pelos adapters para simular latencia de rede.
 *
 * Assinatura injetavel: os testes substituem esta funcao por uma que resolve
 * de imediato, o que mantem a suite rapida e deterministica sem depender de
 * fake timers — que nao interceptam `node:timers/promises` de forma confiavel.
 *
 * Rejeita com `AbortError` quando o `signal` dispara durante a espera.
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = async (ms, signal) => {
  await (signal === undefined ? sleepFor(ms) : sleepFor(ms, undefined, { signal }));
};
