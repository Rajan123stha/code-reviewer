/**
 * Replace likely secrets with placeholders before any code is sent to an LLM.
 *
 * Line structure is preserved exactly (no newlines are added or removed), so line numbers
 * in diffs and files stay valid. The patterns favor recall on well-known token formats over
 * catching every possible secret; they are a safety net, not a secret scanner.
 */
interface SecretPattern {
  name: string;
  pattern: RegExp;
  /** Group index holding the secret value; the rest of the match is kept. Default: whole match. */
  group?: number;
}

const PATTERNS: SecretPattern[] = [
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe-key', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]{3,})@/gi,
    group: 1,
  },
  {
    // key = "value" / key: 'value' / KEY=value for secret-sounding names.
    name: 'assigned-secret',
    pattern:
      /\b[\w.-]*(?:secret|password|passwd|pwd|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret)[\w.-]*["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/gi,
    group: 1,
  },
];

const PEM_BLOCK = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g;

export interface ScrubResult {
  text: string;
  /** Count of redactions per pattern name. */
  redactions: Record<string, number>;
}

export function scrubSecrets(text: string): ScrubResult {
  const redactions: Record<string, number> = {};
  const count = (name: string) => (redactions[name] = (redactions[name] ?? 0) + 1);

  // Keep every line of a PEM block but blank its body, so line numbers do not shift.
  let out = text.replace(PEM_BLOCK, (_match, kind: string, body: string) => {
    count('private-key');
    const blanked = body.replace(/[^\r\n]+/g, '[REDACTED:private-key]');
    return `-----BEGIN ${kind}-----${blanked}-----END ${kind}-----`;
  });

  for (const { name, pattern, group } of PATTERNS) {
    out = out.replace(pattern, (match: string, ...groups: unknown[]) => {
      if (match.includes('[REDACTED:')) return match;
      count(name);
      const placeholder = `[REDACTED:${name}]`;
      if (group === undefined) return placeholder;
      const secret = groups[group - 1] as string;
      return match.replace(secret, placeholder);
    });
  }
  return { text: out, redactions };
}
