# ADR 0002: Webhook ingestion

- Status: accepted
- Date: 2026-10-01

## Context

GitHub delivers webhooks at least once. It waits 10 seconds for a response, records the delivery as
failed after that, and lets users redeliver by hand. Reviews take tens of seconds or more, so the
webhook handler must hand off the work and respond quickly.

## Decisions

1. **Verify before parsing.** The webhook route has its own content-type parser that keeps the body
   as a `Buffer`. The handler checks the HMAC-SHA256 of those exact bytes in constant time
   (`timingSafeEqual`), and only then parses the JSON. Verifying a re-serialized object would break
   on any whitespace or key-order difference. A test pins this behavior.
2. **Respond 202 after enqueueing.** The handler does no GitHub API calls and no database writes.
   It enqueues a job and returns.
3. **Deduplicate with a deterministic job id**: `pr-<repositoryId>-<prNumber>-<headSha>`. BullMQ
   ignores an `add` whose id already exists, so redeliveries and duplicate events for the same
   commit produce one review. A new push gets a new id. This is not a permanent guarantee: an id
   becomes free again after BullMQ removes the completed job (we keep the last 1,000). Later,
   persisting reviews in Postgres will give durable idempotency.
4. **Fail fast when Redis is down.** The producer connection disables the ioredis offline queue, and
   `enqueue` has a 5-second timeout. The handler then returns 500 inside GitHub's window, and the
   delivery can be redelivered.
5. **Trigger only on `opened` and `synchronize`**, as the spec states. `reopened` and
   `ready_for_review` are candidates to add later.
6. **Classify worker errors.** GitHub 401, 404 and 422 responses (bad credentials, deleted PR,
   comment line not in the diff) throw BullMQ's `UnrecoverableError`, which skips retries. All other
   errors retry 3 times with exponential backoff.

## Consequences

- If a webhook is accepted while its event payload is malformed, it returns 400 and is not retried.
  These responses are logged with the zod issues for debugging.
- If a PR gets new pushes quickly, each head commit is reviewed. Cancelling superseded jobs is
  future work.
