import type { TokenUsage } from './types.js';

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache writes; billed at 1.25x input. */
  cacheWrite: number;
}

/**
 * Anthropic first-party list prices as of 2026-09-25. Update this table (and the date)
 * when prices change; reviews store their computed cost, so history stays as billed.
 */
export const PRICING_AS_OF = '2026-09-25';

function price(input: number, output: number, cacheRead = input / 10): ModelPricing {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-haiku-4-5': price(1, 5),
  // Test double; free so cost assertions stay simple.
  fake: price(0, 0, 0),
};

/** Cost in USD, or null when the model is not in the table. */
export function computeCostUsd(model: string, usage: TokenUsage): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const micro =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadInputTokens * p.cacheRead +
    usage.cacheCreationInputTokens * p.cacheWrite;
  return micro / 1_000_000;
}
