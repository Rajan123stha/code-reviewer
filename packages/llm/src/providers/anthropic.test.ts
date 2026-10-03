import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider, toLLMError, type AnthropicMessagesClient } from './anthropic.js';

const schema = z.object({ ok: z.boolean() });
const request = {
  model: 'claude-opus-5-5',
  system: 'sys',
  prompt: 'p',
  schema,
  schemaName: 's/v1',
  maxOutputTokens: 500,
  effort: 'high' as const,
};

function fakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    parsed_output: { ok: true },
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: null,
      iterations: null,
    },
    _request_id: 'req_123',
    ...overrides,
  };
}

function fakeClient(result: unknown) {
  const parse = vi.fn((_params: unknown, _options?: unknown) =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const client = { beta: { messages: { parse } } } as unknown as AnthropicMessagesClient;
  return { client, parse };
}

const signal = new AbortController().signal;

describe('AnthropicProvider', () => {
  it('sends a structured-output request and maps usage', async () => {
    const { client, parse } = fakeClient(fakeMessage());
    const res = await new AnthropicProvider(client).generate(request, signal);

    const [params, options] = parse.mock.calls[0]!;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 500,
      system: 'sys',
      messages: [{ role: 'user', content: 'p' }],
      output_config: {
        effort: 'high',
        format: expect.objectContaining({ type: 'json_schema' }) as unknown,
      },
    });
    expect(params).not.toHaveProperty('fallbacks');
    expect(options).toEqual({ signal });
    expect(res).toEqual({
      output: { ok: true },
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
      },
      servedModel: 'claude-opus-5-5',
      fallbackUsed: false,
      stopReason: 'end_turn',
      requestId: 'req_123',
    });
  });

  it('opts into default refusal fallback and reports which model served', async () => {
    const { client, parse } = fakeClient(
      fakeMessage({
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          iterations: [{ type: 'message' }, { type: 'fallback_message' }],
        },
      }),
    );
    const res = await new AnthropicProvider(client).generate(
      { ...request, refusalFallback: true },
      signal,
    );
    expect(parse.mock.calls[0]![0]).toMatchObject({
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(res.fallbackUsed).toBe(true);
    expect(res.servedModel).toBe('claude-opus-4-8');
  });

  it.each([
    [{ stop_reason: 'refusal', stop_details: { category: 'cyber' } }, 'refusal', /cyber/],
    [{ stop_reason: 'max_tokens' }, 'max_tokens', /max_tokens=500/],
    [{ parsed_output: null }, 'invalid_output', /schema/],
  ])('turns %o into a %s error', async (overrides, kind, message) => {
    const { client } = fakeClient(fakeMessage(overrides));
    await expect(new AnthropicProvider(client).generate(request, signal)).rejects.toMatchObject({
      kind,
      message: expect.stringMatching(message) as unknown,
    });
  });
});

describe('toLLMError', () => {
  const headers = new Headers({ 'retry-after': '12' });
  it.each([
    [new Anthropic.RateLimitError(429, {}, 'rate', headers), 'rate_limit', true],
    [new Anthropic.InternalServerError(529, {}, 'overloaded', new Headers()), 'server', true],
    [new Anthropic.BadRequestError(400, {}, 'bad', new Headers()), 'bad_request', false],
    [new Anthropic.AuthenticationError(401, {}, 'auth', new Headers()), 'auth', false],
    [new Anthropic.APIConnectionTimeoutError(), 'timeout', true],
    [new Anthropic.APIConnectionError({ message: 'reset' }), 'connection', true],
    [new Anthropic.APIUserAbortError(), 'timeout', true],
    [new Error('Failed to parse structured output'), 'invalid_output', true],
  ])('maps %s', (error, kind, retryable) => {
    expect(toLLMError(error)).toMatchObject({ kind, retryable });
  });

  it('reads retry-after seconds', () => {
    const err = toLLMError(new Anthropic.RateLimitError(429, {}, 'rate', headers));
    expect(err.retryAfterMs).toBe(12_000);
  });
});
