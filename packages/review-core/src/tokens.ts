/**
 * Token estimate used for budgeting. Deliberately a fixed, deterministic heuristic rather
 * than a tokenizer call: budgets must be identical across runs and strategies, and must not
 * depend on the network. Code averages roughly 3 to 4 characters per token, so dividing
 * by 3 errs on the side of over-counting. Actual input tokens are recorded per review, so
 * the heuristic can be calibrated later.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Greedy budget: callers offer pieces in priority order; a piece fits whole or not at all. */
export class TokenBudget {
  private used = 0;

  constructor(readonly total: number) {}

  get spent() {
    return this.used;
  }

  get remaining() {
    return this.total - this.used;
  }

  tryTake(tokens: number): boolean {
    if (tokens > this.remaining) return false;
    this.used += tokens;
    return true;
  }
}
