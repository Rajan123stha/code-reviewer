# ADR 0003: LLM layer and baseline review pipeline (S0, S1)

- Status: accepted
- Date: 2026-10-01

## Context

Phase 2 adds the first real reviews. Whatever we build here becomes the baseline that every
later strategy (S2 to S5) and the learned filter are measured against. So the pipeline has to
be reproducible, attributable (who answered, at what cost) and shared exactly between the
worker and the eval harness.

## Decisions

### LLM layer (`packages/llm`)

1. **One retry policy, owned by `LLMClient`.** The Anthropic SDK's own retries are turned off
   (`maxRetries: 0`). `LLMClient` retries rate limits, 5xx/529, timeouts, connection errors and
   schema-invalid output, with full-jitter exponential backoff (4 attempts, 1 s base, 30 s cap).
   It waits for `retry-after` when the server sends one. Refusals, auth errors, bad requests and
   `max_tokens` cut-offs are not retried. Every attempt is counted in the call record.
2. **Per-attempt timeout** (default 10 min) through an `AbortController`, so a hung request is
   cancelled before the next attempt starts.
3. **Response cache key**: SHA-256 over provider, model, system prompt, user prompt, schema
   name, schema JSON, max tokens, effort, fallback flag and an optional salt. Timeouts are not
   part of the key. The eval harness passes a run index as the salt, so the ≥3 repeated runs per
   config stay independent samples. Cached outputs are re-validated against the schema on read.
   Cache hits report the original call's cost, so eval cost metrics reflect a fresh run.
4. **Structured outputs** via `client.beta.messages.parse` with a zod schema
   (`betaZodOutputFormat`). There is no free-text JSON parsing.
5. **Refusal fallback on by default** (`fallbacks: "default"`), because code under review
   (auth, crypto, exploit fixes) can trigger safety classifiers. The model that actually answered
   (`servedModel`) and `fallbackUsed` are stored with every review. Ablations can turn the flag
   off, or filter out fallback-served runs, so results stay attributable to one model.
6. **Model and effort**: the default model is `claude-opus-5-5`, with effort set explicitly to
   `high` because Opus 5.5 defaults to `medium`. Both are fields of the strategy config. Cheaper
   models for sweeps are a config change, not a code change.
7. **No prompt caching yet.** Each review is a one-shot request with a short system prompt.
   Cache writes cost 1.25× input with no reuse, so caching would only add cost. Revisit when eval
   reruns send identical prefixes back to back.
8. **Pricing table** in code, dated (`PRICING_AS_OF`). Reviews store the computed cost, so a
   later price change does not rewrite history.
9. A **`FakeProvider`** is the second implementation behind the interface. Tests and the CLI's
   `--dry-run` use it. A second real provider is planned for ablation E6.

### Review pipeline (`packages/review-core`)

1. **`runReview(input, config, deps)`** is the single entry point. The worker and the CLI (and
   later the eval harness) call it unchanged.
2. **`StrategyConfig` is fully explicit** (strategy, model, effort, prompt version, context
   budget, output cap, comment cap, fallback flag) and hashed. The hash is stored with every
   review and is part of the review row's uniqueness key.
3. **Line-labelled diffs.** Every commentable line is shown as `R<new-line-number>`, so the
   model never counts lines. Full files (S1) carry `n|` prefixes and are reference only.
4. **Token budget.** The heuristic is `ceil(chars / 3)`, deterministic and offline. Diffs come
   first and full files fill what is left. A piece fits whole or is left out and listed; it is
   never truncated mid-way. Actual input tokens are stored, so the heuristic can be calibrated.
5. **Validation is strategy-independent.** A comment must be on an added or context line of a
   file in the diff, and its evidence must appear in that file's diff lines or head contents
   (whitespace-normalized, with labels and fences stripped). The index always uses the head
   files, even for S0, so a strategy that showed more code gets no validation advantage.
6. **Dedupe** is greedy in priority order (severity, confidence, then location). Two comments
   are duplicates if they are on the same file within 3 lines and either share line and category
   or have a claim-word Jaccard of at least 0.5. Thresholds are constants, not tuned.
7. **Every candidate is persisted** with its status (`selected`, `over_cap`, `duplicate`,
   `invalid`) and reject reason. These rows are the raw material for the learned filter (Phase 7).
8. **Secret scrubbing** runs on the diff, every file read and the PR text before anything else
   sees them, so the prompt, validation and storage all see the same scrubbed text. Line
   structure is preserved. The patterns cover well-known token formats and assigned secrets.
   They are a safety net, not a scanner.
9. **Prompts are versioned files** (`prompts/review/v1/`). Reviews store both the declared
   version and a content hash, so an edit made without a version bump is detectable.
10. **Untrusted content** (PR text, diffs, files) is wrapped in tags. The system prompt says
    their contents are data, never instructions. Template rendering is single-pass, so
    `{{…}}` inside PR text is not expanded.

### Worker

1. **The diff is pinned to commits** with `compare/{base}...{head}`, not the PR diff endpoint,
   which follows the current head.
2. **Superseded commits are skipped**: if the PR head moved on, a newer job exists.
3. **Idempotent across retries and redeliveries**: the review row is unique per
   (PR, head SHA, config hash). An already-posted row means "do not post again". A failed row is
   reset and reused. This replaces the time-limited BullMQ job-id dedupe noted in ADR 0002 as
   the durable guarantee.
4. **Quiet when there is nothing to say**: if no comment survives, nothing is posted, but the
   review is still finalized (`posted` with a null GitHub id).
5. **Unrecoverable errors** (GitHub 401/404/422, LLM refusal/auth/bad request/max_tokens) stop
   BullMQ retries. Transient errors retry.

### Persistence

Prisma 7 with the `pg` driver adapter. Migrations are generated SQL, committed under
`packages/db/prisma/migrations`. Tests run the real migrations against PGlite (Postgres in WASM)
behind a wire-protocol socket, so they need neither Docker nor a server.

## Known gaps

- A crash between posting to GitHub and `markPosted` can double-post on retry.
- `chars / 3` overestimates for prose-heavy diffs, so budgets are conservative.
- The scrubber misses secrets in formats it does not know.
- Renamed files are reviewed under the new path only.
