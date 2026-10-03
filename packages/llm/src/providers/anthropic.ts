import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { LLMError } from '../errors.js';
import type { GenerateRequest, LLMProvider, ProviderResponse } from '../types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** The SDK surface this provider uses; tests pass a fake. */
export type AnthropicMessagesClient = Pick<Anthropic, 'beta'>;

/**
 * Claude via the Messages API with structured outputs (`output_config.format`).
 *
 * SDK-level retries are disabled: LLMClient owns retries so there is one policy and
 * every attempt is counted. Refusal fallback uses `fallbacks: "default"`, which reruns a
 * policy-declined request on Anthropic's recommended model; `servedModel` records which
 * model actually answered so eval results stay attributable.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: AnthropicMessagesClient;

  constructor(client?: AnthropicMessagesClient) {
    this.client = client ?? new Anthropic({ maxRetries: 0 });
  }

  async generate<T>(
    request: GenerateRequest<T>,
    signal: AbortSignal,
  ): Promise<ProviderResponse<T>> {
    let message;
    try {
      message = await this.client.beta.messages.parse(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: {
            format: betaZodOutputFormat(request.schema),
            ...(request.effort ? { effort: request.effort } : {}),
          },
          ...(request.refusalFallback
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
        },
        { signal },
      );
    } catch (error) {
      throw toLLMError(error);
    }

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified';
      throw new LLMError('refusal', `model declined the request (category: ${category})`);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LLMError(
        'max_tokens',
        `output hit max_tokens=${request.maxOutputTokens} before the JSON was complete`,
      );
    }
    if (message.parsed_output === null) {
      throw new LLMError('invalid_output', 'response did not contain output matching the schema');
    }

    const usage = message.usage;
    return {
      output: message.parsed_output,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      },
      servedModel: message.model,
      fallbackUsed: (usage.iterations ?? []).some((it) => it.type === 'fallback_message'),
      stopReason: message.stop_reason,
      requestId: message._request_id ?? undefined,
    };
  }
}

function retryAfterMs(error: InstanceType<typeof Anthropic.APIError>) {
  const value = error.headers?.get('retry-after');
  const seconds = value ? Number(value) : NaN;
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

/** Map SDK errors to provider-neutral kinds, most specific class first. */
export function toLLMError(error: unknown): LLMError {
  if (error instanceof LLMError) return error;
  const message = (error as Error)?.message ?? String(error);
  const opts = { cause: error };

  if (error instanceof Anthropic.APIUserAbortError) return new LLMError('timeout', message, opts);
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new LLMError('timeout', message, opts);
  if (error instanceof Anthropic.APIConnectionError)
    return new LLMError('connection', message, opts);
  if (error instanceof Anthropic.RateLimitError) {
    const wait = retryAfterMs(error);
    return new LLMError('rate_limit', message, {
      ...opts,
      status: 429,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    });
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return new LLMError('auth', message, { ...opts, status: error.status });
  if (error instanceof Anthropic.APIError) {
    const status = (error as { status?: number }).status;
    // 5xx and 529 (overloaded) are transient; other 4xx mean the request itself is wrong.
    const kind = status !== undefined && status >= 500 ? 'server' : 'bad_request';
    return new LLMError(kind, message, { ...opts, ...(status !== undefined ? { status } : {}) });
  }
  // Anything else thrown during parse() is the SDK failing to validate the output.
  return new LLMError('invalid_output', message, opts);
}
