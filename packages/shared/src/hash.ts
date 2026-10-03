import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted recursively, so equal values always serialize to equal
 * strings. Used for config hashes and cache keys, which must not depend on key order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return val;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Short, stable content hash of any JSON-serializable value. */
export function hashOf(value: unknown, length = 16): string {
  return sha256(stableStringify(value)).slice(0, length);
}
