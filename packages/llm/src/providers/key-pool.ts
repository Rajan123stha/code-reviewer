/**
 * Rotating pool of API keys for one provider. A key that hits a rate limit cools down for
 * the time the server asked for; a key the server rejects is disabled for the life of the
 * process. Keys are only ever identified by label ("key#2") in logs and errors.
 */
export interface PoolKey {
  readonly label: string;
  readonly secret: string;
}

interface KeyState extends PoolKey {
  cooldownUntil: number;
  disabledReason: string | null;
  lastReason: string | null;
}

export interface KeyStatus {
  label: string;
  state: 'ready' | 'cooling' | 'disabled';
  availableInMs?: number;
  reason?: string | null;
}

export class ApiKeyPool {
  private readonly keys: KeyState[];
  private cursor = 0;

  constructor(
    secrets: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    const unique = [...new Set(secrets.map((s) => s.trim()).filter(Boolean))];
    if (unique.length === 0) throw new Error('ApiKeyPool needs at least one API key');
    this.keys = unique.map((secret, i) => ({
      label: `key#${i + 1}`,
      secret,
      cooldownUntil: 0,
      disabledReason: null,
      lastReason: null,
    }));
  }

  get size() {
    return this.keys.length;
  }

  /**
   * Next usable key, round-robin from the last one used, so load spreads across keys
   * instead of draining the first one. Undefined when every key is cooling or disabled.
   */
  acquire(): PoolKey | undefined {
    const t = this.now();
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[(this.cursor + i) % this.keys.length]!;
      if (key.disabledReason === null && key.cooldownUntil <= t) {
        this.cursor = (this.cursor + i + 1) % this.keys.length;
        return key;
      }
    }
    return undefined;
  }

  cooldown(key: PoolKey, ms: number, reason: string) {
    const state = this.find(key);
    state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + ms);
    state.lastReason = reason;
  }

  disable(key: PoolKey, reason: string) {
    this.find(key).disabledReason = reason;
  }

  /** Milliseconds until some key is usable again; undefined if all keys are disabled. */
  msUntilAvailable(): number | undefined {
    const t = this.now();
    const waits = this.keys
      .filter((k) => k.disabledReason === null)
      .map((k) => Math.max(0, k.cooldownUntil - t));
    return waits.length ? Math.min(...waits) : undefined;
  }

  status(): KeyStatus[] {
    const t = this.now();
    return this.keys.map((k) =>
      k.disabledReason !== null
        ? { label: k.label, state: 'disabled', reason: k.disabledReason }
        : k.cooldownUntil > t
          ? {
              label: k.label,
              state: 'cooling',
              availableInMs: k.cooldownUntil - t,
              reason: k.lastReason,
            }
          : { label: k.label, state: 'ready' },
    );
  }

  private find(key: PoolKey): KeyState {
    const state = this.keys.find((k) => k.label === key.label);
    if (!state) throw new Error(`unknown key ${key.label}`);
    return state;
  }
}

/** Split a GEMINI_API_KEYS-style list: commas, semicolons or whitespace. */
export function parseKeyList(...values: (string | undefined)[]): string[] {
  return values.flatMap((v) => (v ?? '').split(/[\s,;]+/)).filter(Boolean);
}
