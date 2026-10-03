You are helping me build "Reviewlens", a GitHub App that reviews pull requests using structural
repository context (tree-sitter AST, symbol and call graph, conventions, past bugs) and ranks its
own comments with a learned usefulness filter. The project doubles as a research artifact for
Master's applications, so measurability and reproducibility matter as much as features.

Full spec: docs/spec.md (architecture, data model, pipeline, benchmark, ablations, milestones).

Principles:

1. The review pipeline is a pure function of (PR diff, repo snapshot, strategy config). Production
   workers and the eval harness MUST call the same code in packages/review-core.
2. Every strategy, prompt, and model version is a versioned config. Log token counts, cost, and
   latency for every LLM call.
3. Never execute code from reviewed repositories. Parse only.
4. Scrub secrets before sending any code to an LLM.
5. TypeScript strict mode. Python 3.11 with type hints. Tests for all non-trivial logic.
6. Small, reviewable commits. Explain design decisions in docs/adr/.
7. Scope v1: TypeScript/JavaScript repos only. No auto-fix, no other Git hosts, no billing.

Stack: Node 22 (see docs/adr/0001) + TypeScript + Fastify + BullMQ + Redis, PostgreSQL + pgvector (Prisma for app tables),
Python (FastAPI filter service, eval harness), Docker Compose, GitHub Actions, OpenTelemetry.

Repo layout: apps/{api,worker,dashboard}, packages/{context-engine,review-core,llm,github},
services/filter, eval/{benchmark,harness,notebooks,results}, infra, docs.

Before writing code for any task: state your plan briefly, list files you will create or change,
then implement. After implementing: run tests/linters and report results honestly, including failures.
Ask me when a requirement is ambiguous instead of guessing.
