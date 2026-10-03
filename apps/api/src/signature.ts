import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * Verify GitHub's `X-Hub-Signature-256` header: HMAC-SHA256 of the raw request body
 * keyed with the webhook secret. Must run on the exact bytes received, before JSON parsing.
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!secret || !header?.startsWith(PREFIX)) return false;

  const received = Buffer.from(header.slice(PREFIX.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();

  // timingSafeEqual throws on length mismatch; malformed hex also yields a short buffer.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signGitHubPayload(secret: string, rawBody: Buffer | string): string {
  return PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}
