# Reviewlens: Build Spec

A GitHub App that reviews pull requests using structural repository context (AST, symbol and call graph, conventions, past bugs), then filters its own comments with a learned usefulness model. Every design choice is validated against a benchmark built from real bug-fix history.

## 1. Research questions

- **RQ1:** Does structural context (call graph, symbol definitions) improve bug-catch recall and comment precision over diff-only and embedding-only retrieval?
- **RQ2:** How much of the improvement comes from _which_ context vs. _how much_ context? (Control for token budget.)
- **RQ3:** Can a learned usefulness filter cut low-value comments substantially while keeping most of the true-bug recall?
- **RQ4:** What is the cost/latency trade-off of each strategy?

Results are framed as an ablation table with confidence intervals.

## 2. Scope (v1)

**In scope:** TypeScript/JavaScript first (Python second if time allows); GitHub App posting reviews with inline comments; context engine (tree-sitter, symbol index, import/call graph, conventions); learned comment filter; offline eval harness + benchmark builder; minimal dashboard.

**Out of scope:** auto-fixing/committing code; GitLab/Bitbucket; fine-tuning a foundation model; more than 2 languages; billing.

## 3. Architecture

```
GitHub ──webhook──▶ API (Node/TS, Fastify)
                      │  verify signature, enqueue
                      ▼
                 Queue (BullMQ/Redis)
                      │
        ┌─────────────┴──────────────┐
        ▼                            ▼
  Indexer worker               Review worker
  (clone/fetch, tree-sitter,   (build context → LLM candidates
   symbols, call graph,         → filter/rank → post to GitHub)
   embeddings)                       │
        │                            ▼
        ▼                     Filter service (Python/FastAPI)
  PostgreSQL + pgvector        scores candidate comments
        ▲
        │
  Eval harness (Python) — replays benchmark PRs through the same
  review pipeline with swappable context strategies
```

Key principle: **the review pipeline is a pure function of (PR diff, repo snapshot, strategy config)**. The eval harness and the production worker call the same code.

## 4. Tech stack

| Concern             | Choice                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| API + workers       | Node 22 (ADR 0001), TypeScript, Fastify, BullMQ, Octokit (`@octokit/app`)                           |
| Parsing             | tree-sitter (`web-tree-sitter` or native bindings)                                                  |
| DB                  | PostgreSQL + pgvector, Prisma for app tables, raw SQL for graph queries                             |
| Queue               | Redis                                                                                               |
| LLM                 | Provider-agnostic interface (Claude API first; one more provider to prove the abstraction)          |
| Filter + eval       | Python 3.11, FastAPI, scikit-learn/LightGBM, pandas, pytest                                         |
| Experiment tracking | MLflow or W&B (or versioned JSON + DVC)                                                             |
| Observability       | OpenTelemetry traces, Prometheus metrics, structured logs; Langfuse or similar for LLM traces       |
| Deploy              | Docker Compose locally; one cloud target (AWS ECS/Fargate or a single VM); CI/CD via GitHub Actions |

## 5. Data model (starting point)

- `installations(id, github_installation_id, account, created_at)`
- `repositories(id, installation_id, full_name, default_branch, last_indexed_sha, config_json)`
- `files(id, repo_id, path, language, sha, blob_hash)`
- `symbols(id, file_id, name, kind, start_line, end_line, signature, parent_symbol_id)`
- `edges(id, repo_id, src_symbol_id, dst_symbol_id, kind)`: `calls | imports | extends | references`
- `chunks(id, symbol_id, text, embedding vector(N))`
- `conventions(id, repo_id, rule_text, source, evidence_json)`
- `pull_requests(id, repo_id, number, head_sha, base_sha, status)`
- `reviews(id, pr_id, strategy_config_json, model, started_at, finished_at, tokens_in, tokens_out, cost_usd)`
- `candidate_comments(id, review_id, file_path, line, body, category, severity, llm_confidence, filter_score, posted bool)`
- `comment_feedback(id, candidate_comment_id, outcome, source, observed_at)`: `resolved_with_change | dismissed | thumbs_up | thumbs_down | ignored`
- `bug_history(id, repo_id, fix_commit_sha, bug_commit_sha, files_json, summary)`

## 6. Review pipeline (per PR)

1. **Ingest:** diff, changed files, PR title/description. Map diff hunks to AST symbols.
2. **Context build** (experiment variable), same token budget per strategy unless varied deliberately:
   - S0 diff only
   - S1 diff + full changed files
   - S2 diff + embedding top-k chunks
   - S3 diff + AST context (enclosing symbols, definitions of called symbols)
   - S4 S3 + call graph (callers and callees to depth _d_, token-budgeted)
   - S5 S4 + conventions + similar past bugs
3. **Generate candidates:** structured JSON `{file, line, category, severity, claim, evidence, suggested_fix}`. Reject candidates whose line is not in the diff or whose evidence is not found.
4. **Dedupe + verify:** cluster near-duplicates; optional verifier prompt that tries to refute each candidate.
5. **Filter/rank:** learned usefulness score; post top-N above threshold; cap per PR.
6. **Post:** single GitHub review with inline comments; feedback affordance.
7. **Learn:** webhook listeners record outcomes into `comment_feedback`.

## 7. Learned usefulness filter

**Labels:** offline bootstrap from public repos' historical review comments (label = comment followed by a commit changing the commented lines; noisy) and online accept/dismiss signals.

**Features:** comment (category, severity, LLM confidence, length, has-fix, evidence-grounded); location (file type, is-test, change size, symbol centrality); context (strategy, verifier agreement, duplicate-cluster size); repo (past acceptance rate per category).

**Models:** logistic regression, then gradient boosting. Report AUROC, precision@k, calibration. Leave-one-repo-out evaluation.

## 8. Benchmark

**A: Bug localization from real history (primary)**

1. 15-30 active OSS TS/JS repos with good PR hygiene.
2. Find bug-fix commits/PRs (labels, "fixes #N", keywords).
3. SZZ (simplified blame-based first) to find the bug-introducing commit/PR.
4. Case = introducing PR's diff + repo snapshot at its base. Ground truth = lines modified by the later fix.
5. Keep small, clearly linked fixes; manually validate ~100 cases; report label-noise rate.
6. Hit = comment overlapping the ground-truth region (line-proximity rule first; calibrated LLM judge second).

**B: Human-review agreement (secondary):** overlap with human comments that led to changes.

**Metrics:** bug-catch recall@k, comment precision, noise rate, localization accuracy, cost per PR, p50/p95 latency, tokens.

**Rigor:** fixed test split before tuning; held-out repos for the filter; contamination check via post-cutoff cases and date-split reporting; bootstrap CIs and paired comparisons; ≥3 runs per config; ~200 human-labeled comments with second labeler subset (Cohen's kappa); pin model versions, prompts, seeds.

## 9. Ablation plan

| Experiment | Variable                                          | Held constant          |
| ---------- | ------------------------------------------------- | ---------------------- |
| E1         | Strategies S0 to S5                               | model, budget, prompts |
| E2         | Token budget (4k/8k/16k/32k)                      | strategy S4            |
| E3         | Call-graph depth (0/1/2/3)                        | budget                 |
| E4         | With/without verifier pass                        | S4                     |
| E5         | With/without learned filter at several thresholds | S4                     |
| E6         | Two different LLMs                                | S4                     |
| E7         | With/without past-bug retrieval                   | S5                     |

Output: one results table per experiment; Pareto plot of recall vs. noise vs. cost.

## 10. Repository layout

```
reviewlens/
  apps/{api,worker,dashboard}
  packages/{context-engine,review-core,llm,github}
  services/filter
  eval/{benchmark,harness,notebooks,results}
  infra/
  docs/
```

## 11. Milestones (~14-16 weeks)

| Weeks | Deliverable                                                                                |
| ----- | ------------------------------------------------------------------------------------------ |
| 1-2   | Scaffold, GitHub App registered, webhook → queue → hardcoded comment. CI, Docker, tracing. |
| 3-4   | LLM layer + S0/S1, structured outputs, validation. First real review.                      |
| 5-6   | tree-sitter indexer, symbols, diff→symbol mapping, S3. Schema + migrations.                |
| 7-8   | Call graph, S4, token-budgeted assembly. pgvector + S2.                                    |
| 7-10  | Benchmark A builder, SZZ, repo selection, manual validation.                               |
| 9-10  | Eval harness, metrics, E1.                                                                 |
| 11-12 | Feedback capture, filter dataset, filter v1, E5.                                           |
| 13-14 | Verifier, conventions, past-bug retrieval (S5), remaining ablations.                       |
| 15-16 | Dashboard, deploy, 3-5 beta users, write-up, demo video.                                   |

**Cut order if behind:** Python support → S5 → second LLM → dashboard polish. Never cut the benchmark or E1/E5.

## 12. Risks

| Risk           | Mitigation                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Crowded space  | Compete on measured quality and transparency. Publish the benchmark.                           |
| Label noise    | Manual validation sample; report noise rate; conservative matching.                            |
| Eval LLM cost  | Cache aggressively, cap cases, cheap model for sweeps.                                         |
| Contamination  | Date-split analysis; post-cutoff cases.                                                        |
| Scope creep    | Language limit, out-of-scope list, weekly milestone check.                                     |
| Untrusted code | Never execute repo code; sandboxed cloning; least-privilege app permissions; secret scrubbing. |

## 13. Definition of done

- Installable GitHub App on ≥3 external repos with real users
- Public repo with architecture docs, ADRs, reproducible `make eval`
- Benchmark released (manifests + builder scripts, license-respecting)
- Ablation tables with CIs, filter AUROC/precision@k, cost/latency
- 6-10 page technical report; 2-minute demo video

## 14. Phase plan

1. Scaffold + walking skeleton (webhook → BullMQ → worker posts hardcoded inline comment; docker-compose; CI; logging/OTel; signature + enqueue tests).
2. LLM layer (`packages/llm`) + S0/S1 in `review-core`; validation, dedupe; versioned prompts; persist reviews.
3. Context engine: tree-sitter symbols, edges, incremental indexing, diff→symbol mapping, deterministic context assembly; S3/S4.
4. Embeddings (S2), conventions extraction, past-bug retrieval, S5; each source toggleable.
5. Benchmark builder: bug-fix mining, SZZ, versioned case manifest, filters, validation CLI, date metadata. Target ≥300 candidate cases.
6. Eval harness: run configs over manifests with caching/resume; metrics; bootstrap CIs; E1-E7 YAML; notebook; `make eval-smoke`.
7. Learned filter service: dataset builder, features, LR → LightGBM, leave-one-repo-out CV, `/score`, threshold sweeps, split-hygiene test.
8. Feedback listeners, Next.js dashboard, `.reviewlens.yml`, rate/cost limits, deploy, docs.
9. Write-up (`docs/paper.md`), all numbers pulled programmatically from result files; no invented citations.
