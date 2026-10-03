import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FileCache, MemoryCache } from './cache.js';
import { LLMClient } from './client.js';
import { LLMError } from './errors.js';
import { computeCostUsd } from './pricing.js';
import { FakeProvider } from './providers/fake.js';
import type { GenerateRequest, LLMCallRecord, LLMProvider } from './types.js';

const schema = z.object({ answer: z.number() });
const request: GenerateRequest<z.infer<typeof schema>> = {
  model: 'claude-opus-5-5',
  system: 'sys',
  prompt: 'what is 2+2',
  schema,
  schemaName: 'answer/v1',
  maxOutputTokens: 100,
};

const noSleep = (_ms: number) => Promise.resolve();

describe('LLMClient', () => {
  it('returns validated output with cost computed from the served model', async () => {
    const provider = new FakeProvider(() => ({ answer: 4 }));
    const client = new LLMClient({ provider });
    const result = await client.generate(request);

    expect(result.output).toEqual({ answer: 4 });
    expect(result.cached).toBe(false);
    expect(result.attempts).toBe(1);
    // FakeProvider bills 1000 in / 200 out at Opus 5.5 prices ($4 / $20 per MTok).
    expect(result.costUsd).toBeCloseTo(0.004 + 0.004, 10);
  });

  it('serves repeat requests from the cache without calling the provider', async () => {
    const provider = new FakeProvider(() => ({ answer: 4 }));
    const client = new LLMClient({ provider, cache: new MemoryCache() });
    const first = await client.generate(request);
    const second = await client.generate(request);

    expect(provider.requests).toHaveLength(1);
    expect(second.cached).toBe(true);
    expect(second.output).toEqual(first.output);
    expect(second.costUsd).toBe(first.costUsd);
  });

  it('keys the cache on every output-affecting field, including the salt', async () => {
    const client = new LLMClient({ provider: new FakeProvider(() => ({ answer: 1 })) });
    const key = client.cacheKey(request);
    expect(client.cacheKey({ ...request })).toBe(key);
    expect(client.cacheKey({ ...request, prompt: 'x' })).not.toBe(key);
    expect(client.cacheKey({ ...request, model: 'claude-sonnet-5-5' })).not.toBe(key);
    expect(client.cacheKey({ ...request, effort: 'high' })).not.toBe(key);
    expect(client.cacheKey({ ...request, cacheSalt: 'run-2' })).not.toBe(key);
    expect(client.cacheKey({ ...request, schema: z.object({ answer: z.string() }) })).not.toBe(key);
    // Timeouts do not change the output, so they must not split the cache.
    expect(client.cacheKey({ ...request, timeoutMs: 5 })).toBe(key);
  });

  it('regenerates when a cached entry no longer matches the schema', async () => {
    const cache = new MemoryCache();
    const provider = new FakeProvider(() => ({ answer: 4 }));
    const client = new LLMClient({ provider, cache });
    await cache.set(client.cacheKey(request), {
      output: { answer: 'four' },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      servedModel: request.model,
      fallbackUsed: false,
      stopReason: 'end_turn',
      costUsd: 0,
    });
    const result = await client.generate(request);
    expect(result.cached).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it('retries retryable errors with growing backoff, honoring retry-after', async () => {
    const provider = new FakeProvider((_req, call) =>
      call === 1
        ? new LLMError('rate_limit', 'slow down', { retryAfterMs: 7_000 })
        : call === 2
          ? new LLMError('server', 'overloaded', { status: 529 })
          : { answer: 4 },
    );
    const sleep = vi.fn(noSleep);
    const client = new LLMClient({
      provider,
      sleep,
      random: () => 0.5,
      retry: { baseDelayMs: 1_000, maxDelayMs: 30_000 },
    });
    const result = await client.generate(request);

    expect(result.attempts).toBe(3);
    // attempt 1: max(retry-after 7000, 0.5 * 1000); attempt 2: 0.5 * 2000
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([7_000, 1_000]);
  });

  it('does not retry non-retryable errors and reports the failure', async () => {
    const records: LLMCallRecord[] = [];
    const provider = new FakeProvider(() => new LLMError('refusal', 'declined'));
    const client = new LLMClient({ provider, sleep: noSleep, onCall: (r) => records.push(r) });

    await expect(client.generate(request)).rejects.toMatchObject({ kind: 'refusal' });
    expect(provider.requests).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({ attempts: 1, error: { kind: 'refusal', message: 'declined' } }),
    ]);
  });

  it('gives up after maxAttempts', async () => {
    const provider = new FakeProvider(() => new LLMError('connection', 'reset'));
    const client = new LLMClient({ provider, sleep: noSleep, retry: { maxAttempts: 3 } });
    await expect(client.generate(request)).rejects.toMatchObject({ kind: 'connection' });
    expect(provider.requests).toHaveLength(3);
  });

  it('times out a hung attempt, aborts it, and retries', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const provider: LLMProvider = {
      name: 'hang-once',
      generate: (req, signal) => {
        signals.push(signal);
        if (++calls === 1) return new Promise(() => {});
        return Promise.resolve({
          output: req.schema.parse({ answer: 4 }),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          servedModel: req.model,
          fallbackUsed: false,
          stopReason: 'end_turn',
        });
      },
    };
    const client = new LLMClient({ provider, sleep: noSleep, defaultTimeoutMs: 20 });
    const result = await client.generate(request);
    expect(result.attempts).toBe(2);
    expect(signals[0]!.aborted).toBe(true);
  });

  it('emits one call record per request with usage and cost', async () => {
    const records: LLMCallRecord[] = [];
    const client = new LLMClient({
      provider: new FakeProvider(() => ({ answer: 4 })),
      onCall: (r) => records.push(r),
    });
    await client.generate(request);
    expect(records).toEqual([
      expect.objectContaining({
        provider: 'fake',
        requestedModel: 'claude-opus-5-5',
        servedModel: 'claude-opus-5-5',
        schemaName: 'answer/v1',
        cached: false,
        usage: expect.objectContaining({ inputTokens: 1_000, outputTokens: 200 }) as unknown,
      }),
    ]);
  });
});

describe('FileCache', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips entries and misses cleanly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-cache-'));
    const cache = new FileCache(dir);
    const entry = {
      output: { answer: 4 },
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      servedModel: 'm',
      fallbackUsed: false,
      stopReason: 'end_turn',
      costUsd: 0.5,
    };
    expect(await cache.get('abcdef')).toBeUndefined();
    await cache.set('abcdef', entry);
    expect(await cache.get('abcdef')).toEqual(entry);
  });

  it('rejects keys that could escape the directory', async () => {
    const cache = new FileCache('unused');
    await expect(cache.get('../etc/passwd')).rejects.toThrow('invalid cache key');
  });
});

describe('computeCostUsd', () => {
  it('prices every token class, and returns null for unknown models', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    // Opus 5.5: 4 + 20 + 0.20 + 5 (1.25 x 4)
    expect(computeCostUsd('claude-opus-5-5', usage)).toBeCloseTo(29.2, 10);
    expect(computeCostUsd('some-unknown-model', usage)).toBeNull();
  });
});
