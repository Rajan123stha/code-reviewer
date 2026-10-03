import { describe, expect, it } from 'vitest';
import { signGitHubPayload, verifyGitHubSignature } from './signature.js';

const SECRET = "It's a Secret to Everybody";
const BODY = Buffer.from('Hello, World!');

describe('verifyGitHubSignature', () => {
  it('matches the test vector from GitHub docs', () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(verifyGitHubSignature(SECRET, BODY, header)).toBe(true);
  });

  it('accepts a signature produced by signGitHubPayload', () => {
    expect(verifyGitHubSignature(SECRET, BODY, signGitHubPayload(SECRET, BODY))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyGitHubSignature(SECRET, BODY, signGitHubPayload('other', BODY))).toBe(false);
  });

  it('rejects a tampered body', () => {
    const header = signGitHubPayload(SECRET, BODY);
    expect(verifyGitHubSignature(SECRET, Buffer.from('Hello, World?'), header)).toBe(false);
  });

  it.each([
    ['missing header', undefined],
    ['missing prefix', signGitHubPayload(SECRET, BODY).slice('sha256='.length)],
    ['sha1 prefix', signGitHubPayload(SECRET, BODY).replace('sha256=', 'sha1=')],
    ['truncated digest', signGitHubPayload(SECRET, BODY).slice(0, -2)],
    ['non-hex digest', 'sha256=' + 'z'.repeat(64)],
    ['empty digest', 'sha256='],
  ])('rejects %s', (_name, header) => {
    expect(verifyGitHubSignature(SECRET, BODY, header)).toBe(false);
  });

  it('rejects everything when the secret is empty', () => {
    expect(verifyGitHubSignature('', BODY, signGitHubPayload('', BODY))).toBe(false);
  });
});
