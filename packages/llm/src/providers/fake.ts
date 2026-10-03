import type { GenerateRequest, LLMProvider, ProviderResponse, TokenUsage } from '../types.js';

/** An output object, or an Error to throw. */
export type FakeReply = unknown;

/**
 * Deterministic provider for tests and offline runs. Returns `reply(request)` as the output
 * (validated against the request schema, like a real provider) or throws it if it is an Error.
 */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly requests: GenerateRequest<unknown>[] = [];

  constructor(
    private readonly reply: (request: GenerateRequest<unknown>, call: number) => FakeReply,
    private readonly usage: TokenUsage = {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ) {}

  async generate<T>(request: GenerateRequest<T>): Promise<ProviderResponse<T>> {
    this.requests.push(request);
    const reply = this.reply(request, this.requests.length);
    if (reply instanceof Error) throw reply;
    return {
      output: request.schema.parse(reply),
      usage: this.usage,
      servedModel: request.model,
      fallbackUsed: false,
      stopReason: 'end_turn',
    };
  }
}
