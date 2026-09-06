import type {
  LlmCallOptions,
  LlmProvider,
  LlmReply,
  LlmRequest,
} from '../../application/ports/llm-provider.js';
import {
  PermanentIntegrationError,
  TransientIntegrationError,
} from '../../domain/errors/integration-error.js';
import { sleep, type Sleep } from '../support/sleep.js';

/** Falhas transitorias plausiveis de um provedor de LLM sob carga. */
const TRANSIENT_FAILURES = [
  'LLM upstream timed out',
  'LLM rate limit exceeded (429)',
  'LLM temporarily unavailable (503)',
] as const;

export interface FlakyLlmProviderOptions {
  readonly minLatencyMs?: number;
  readonly maxLatencyMs?: number;
  /** Probabilidade de falha transitoria (0..1). */
  readonly failureRate?: number;
  /** Probabilidade de falha permanente (0..1), avaliada apos a transitoria. */
  readonly permanentFailureRate?: number;
  readonly model?: string;
  /** Injetavel: torna o sorteio deterministico em teste. */
  readonly random?: () => number;
  /** Injetavel: elimina espera real em teste, sem depender de fake timers. */
  readonly sleep?: Sleep;
}

/**
 * Mock do provedor de LLM que reproduz o comportamento causador do incidente:
 * latencia alta e variavel, com falhas intermitentes.
 *
 * A latencia e sorteada e *aguardada antes* da falha de proposito — no mundo
 * real o erro chega depois da espera, nao no lugar dela. Um mock que falha
 * instantaneamente esconderia justamente o custo que a fila existe para
 * absorver.
 */
export class FlakyLlmProvider implements LlmProvider {
  readonly #minLatencyMs: number;
  readonly #maxLatencyMs: number;
  readonly #failureRate: number;
  readonly #permanentFailureRate: number;
  readonly #model: string;
  readonly #random: () => number;
  readonly #sleep: Sleep;

  constructor(options: FlakyLlmProviderOptions = {}) {
    this.#minLatencyMs = options.minLatencyMs ?? 500;
    this.#maxLatencyMs = options.maxLatencyMs ?? 4_000;
    this.#failureRate = options.failureRate ?? 0.3;
    this.#permanentFailureRate = options.permanentFailureRate ?? 0;
    this.#model = options.model ?? 'mock-llm-v1';
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? sleep;
  }

  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmReply> {
    // Falha deterministica: nenhum retry transforma prompt vazio em resposta.
    if (request.prompt.trim().length === 0) {
      throw new PermanentIntegrationError('LLM prompt is empty');
    }

    const latencyMs = this.#nextLatencyMs();
    await this.#sleep(latencyMs, options.signal);
    this.#maybeFail();

    return {
      text: buildReply(request.prompt),
      model: this.#model,
      latencyMs,
    };
  }

  #nextLatencyMs(): number {
    const span = Math.max(0, this.#maxLatencyMs - this.#minLatencyMs);
    return Math.round(this.#minLatencyMs + this.#random() * span);
  }

  #maybeFail(): void {
    if (this.#random() < this.#failureRate) {
      const index = Math.floor(this.#random() * TRANSIENT_FAILURES.length);
      throw new TransientIntegrationError(
        TRANSIENT_FAILURES[index] ?? TRANSIENT_FAILURES[0],
      );
    }

    if (this.#random() < this.#permanentFailureRate) {
      throw new PermanentIntegrationError('LLM rejected the request (400)');
    }
  }
}

/**
 * Resposta sintetica. Ecoa apenas o inicio do prompt para tornar visivel, em
 * teste manual, que o worker processou a mensagem certa.
 */
function buildReply(prompt: string): string {
  const excerpt = prompt.length > 40 ? `${prompt.slice(0, 40)}...` : prompt;
  return `Recebi sua mensagem ("${excerpt}") e ja estou verificando.`;
}
