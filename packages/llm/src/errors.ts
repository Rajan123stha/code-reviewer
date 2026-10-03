export type LLMErrorKind =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'connection'
  | 'auth'
  | 'bad_request'
  | 'refusal'
  | 'max_tokens'
  | 'invalid_output';

const RETRYABLE: ReadonlySet<LLMErrorKind> = new Set([
  'rate_limit',
  'server',
  'timeout',
  'connection',
  // Schema violations are rare with constrained decoding; one more sample usually fixes them.
  'invalid_output',
]);

/** Provider-neutral error. Providers translate their SDK errors into this. */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Server-requested wait before retrying (from retry-after), if any. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: LLMErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LLMError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
