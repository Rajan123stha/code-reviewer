# ADR 0005: Context engine (tree-sitter symbols, call graph, S3/S4)

- Status: accepted
- Date: 2026-10-01

## Context

Phase 3 adds structural context, the variable behind RQ1: for each change, show the model the
changed symbols, the code they call and the code that calls them, ranked by graph distance and
held to the same token budget as every other strategy.

## Decisions

### Parsing

- **tree-sitter through `web-tree-sitter` (WASM)**, with the grammar `.wasm` files shipped in
  `tree-sitter-typescript` and `tree-sitter-javascript`. The native bindings need a C++
  toolchain to build on Windows; WASM runs everywhere Node runs. Parsing is syntactic only;
  nothing from the repository is executed.
- **Languages**: `.ts .mts .cts` (TypeScript), `.tsx` (TSX), and `.js .jsx .mjs .cjs`
  (JavaScript). Declaration files, minified files, files over 512 KB, and `node_modules`,
  `dist`, `build`, `vendor` and similar directories are skipped.
- **Extracted per file**: symbols (module, function, class, method, interface, type, enum,
  module-level variable) with ranges, signatures, export flags and parents. Also ES imports
  and re-exports, CommonJS `require` and `module.exports`/`exports.x`, call sites (`f()`,
  `this.m()`, `obj.m()`, `new C()`, JSX `<Component>`), and `extends`/`implements`. Locals
  inside functions, including anonymous callbacks, are not symbols.
- **`PARSER_VERSION`** is part of every cache key; bump it when extraction output changes
  (now 2).

### Linking (static, best-effort)

The resolver handles:

- relative imports, including `.js` specifiers that point to `.ts` files and `index` files;
- re-export chains (`export *`, `export { a as b } from`);
- same-file names;
- `this.method`, including one level of inherited methods;
- namespace imports (`ns.fn()`) and static calls on imported classes;
- `new C()`, which links to the class.

**Known limits** (calls that stay unresolved):

- dynamic dispatch on instances (`obj.method()` where `obj` is a value);
- calls through variables, parameters and higher-order functions;
- tsconfig `paths` and `baseUrl` aliases, and package and workspace imports;
- re-assigned or computed exports;
- local shadowing of a top-level name. This can link to the wrong target.

Measured on three repos (below), 15 to 22% of all call expressions resolve. The rest are
mostly calls into built-ins and dependencies (`console.log`, `t.is`, `fs.readFile`), which are
out of scope by design.

### Incremental indexing

- **Content-addressed parse cache**: key = `v<PARSER_VERSION>-<language>-<git blob sha>`.
  Unchanged files are never re-read or re-parsed, whatever commit or repository they appear in.
  Production stores it in Postgres (`parsed_blobs`); the CLI and eval use JSON files.
- **Linking is in memory and runs every time.** It takes about 100 ms for repos of this size
  and is deterministic: paths are sorted, so global ids and edge order are stable.
- **Repository index tables** (`files`, `symbols`, `edges`) hold the default-branch graph at
  `repositories.last_indexed_sha`. A `push` to the default branch enqueues an index job.
  Rows are rewritten only for files whose blob or parser version changed. Edges are rebuilt
  for the whole repository, because resolution crosses files. These tables serve analytics
  and the learned filter's features (e.g. call-graph in-degree). Reviews build the head-commit
  graph themselves from the snapshot, so a review never depends on index freshness.

### Diff to symbols

Added lines map to the innermost symbol containing them. A pure deletion maps through the
head line just before it, so a deletion between two methods lands in the class. Module-level
changes map to the module symbol.

### Context assembly

- **Seeds**: changed symbols.
- **Ranking**: by distance; within a distance, callee and base before caller, then symbols
  reached from more seeds (fan-in), then path and line.
- **S3**: enclosing bodies plus direct callees and bases (1 hop).
- **S4**: callees and callers to `graphDepth` hops (default 2; ablation E3 varies it).
- **Module-level seeds** follow only the calls on the changed lines. Following all of a
  module's calls flooded the context with every test helper in a test file (seen on ky).
- **Rendering**: a symbol is shown whole when it fits `maxSymbolTokens` (1,500). A changed
  symbol that is too large is shown as its signature plus ±15 lines around the change. Others
  fall back to their signature. A symbol is skipped when a symbol containing it is already
  shown.
- **Budget**: diffs come first; symbols spend only what the diffs leave. The total stays
  within `contextTokenBudget`, the same as S0 and S1.
- **Validation is unchanged**: evidence must come from the commented file's diff or head
  contents, never from reference symbols. Prompt `review/v2` says so. All presets moved to v2,
  so E1 compares strategies under one prompt.

## Measurements (local, warm OS cache, Windows 10)

| Repo (HEAD)     | Files | Symbols | Call edges | Imports resolved | Cold index | Warm index |
| --------------- | ----: | ------: | ---------: | ---------------: | ---------: | ---------: |
| sindresorhus/ky |    87 |     866 |        327 |          241/241 |      1.4 s |     0.12 s |
| pinojs/pino     |   156 |     970 |        302 |          212/244 |      1.7 s |     0.15 s |
| tj/commander.js |   170 |     570 |        449 |          172/172 |      1.8 s |     0.17 s |

"Imports resolved" counts imports of files inside the repository; package imports are excluded.
In pino, CommonJS exports built in ways the extractor does not model are unresolved.

## Consequences

- S3 and S4 need a snapshot that can list files: the GitHub tree API in production,
  `git ls-tree` in the CLI.
- The first review of a large repository reads every source file through the contents API (one
  request per file). That is fine within GitHub's limits for repositories of this size;
  fetching a tarball for cold starts is future work.
- Python (spec stretch goal) needs only a grammar, an extractor and resolver rules; the cache,
  graph, assembly and storage are language-neutral.
