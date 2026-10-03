# ADR 0001: Monorepo tooling and runtime

- Status: accepted
- Date: 2026-10-01

## Context

The spec calls for a pnpm monorepo of Node services and shared packages on Node 20. The eval
harness and the production worker must import the same `review-core` code. The workspace packages
therefore need to work in three places without drift: in development (watch mode), in tests, and
in production builds.

## Decisions

### Node 22 LTS instead of Node 20

Node 20 reached end of life in April 2026 and no longer receives security fixes. That matters for a
service that fetches untrusted repositories. The current toolchain also drops it: vitest 5 needs
Node ≥ 22.12. `.nvmrc` and `engines` pin Node 22.

### TypeScript 6.0, not 7

TypeScript 7 (the native port) is the npm `latest` tag. typescript-eslint 8 supports only
`<6.1.0`, and type-aware linting needs it. Revisit this once typescript-eslint supports 7.

### Internal packages resolve through a `source` export condition

Each package under `packages/` exports:

```json
{ "source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
```

- **Typecheck** (`tsconfig.json`, `customConditions: ["source"]`) reads sibling sources. No build
  step is needed first.
- **Dev** (`tsx --conditions=source`) runs sibling sources directly.
- **Tests** (root `vitest.config.ts`) alias `@reviewlens/*` to `packages/*/src/index.ts`.
- **Build** (`tsconfig.build.json`, `customConditions: []`) consumes the siblings' emitted `.d.ts`.
  Plain Node at runtime takes `default`, which is `dist/index.js`. `pnpm -r build` runs in
  dependency order.

The alternatives were TS project references (more config in every package), bundling apps with
tsup/esbuild (breaks OpenTelemetry's module patching) and shipping only TypeScript sources (needs a
TS loader in production).

Trade-off: typecheck and build resolve types differently, so build can fail where typecheck passes.
This happened once with an Octokit `number | bigint` id. CI runs both.

### `packages/shared` is not in the spec layout

The env parsing, the logger, the tracing bootstrap and the queue contract are used by both apps but
belong in neither `github` nor `review-core`. A small `shared` package keeps them in one place. It
must stay free of domain logic.

## Consequences

- New packages copy the same `package.json` exports and the two tsconfig files.
- Production images use `pnpm deploy --prod --legacy` to get a self-contained app directory.
