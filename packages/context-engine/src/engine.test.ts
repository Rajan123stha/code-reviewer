import { parseUnifiedDiff } from '@reviewlens/github';
import { describe, expect, it } from 'vitest';
import { assembleSymbolContext } from './assemble.js';
import { changedSymbols } from './diff-map.js';
import { memorySource, REPO } from './fixtures.js';
import type { RepoGraph } from './graph.js';
import { buildRepoGraph, gitBlobSha, MemoryParseCache } from './indexer.js';
import { languageFor, parseSource } from './parse.js';

async function graphOf(files = REPO) {
  return (await buildRepoGraph(memorySource(files), new MemoryParseCache())).graph;
}

function sym(graph: RepoGraph, path: string, name: string) {
  const s = graph.symbolsIn(path).find((x) => x.qualifiedName === name);
  if (!s) throw new Error(`no symbol ${path}:${name}`);
  return s;
}

function edgesFrom(graph: RepoGraph, path: string, name: string) {
  return graph
    .outgoing(sym(graph, path, name).gid)
    .map((e) => `${e.kind} ${graph.symbols[e.dst]!.path}:${graph.symbols[e.dst]!.qualifiedName}`)
    .sort();
}

describe('parseSource', () => {
  it('extracts symbols with kinds, ranges, signatures and export flags', async () => {
    const p = await parseSource(REPO['src/money.ts']!, 'typescript');
    expect(
      p.symbols.map((s) => [s.qualifiedName, s.kind, s.startLine, s.endLine, s.exported]),
    ).toEqual([
      ['<module>', 'module', 1, 12, false],
      ['round', 'function', 1, 3, true],
      ['Money', 'class', 5, 11, true],
      ['Money.constructor', 'method', 6, 6, false],
      ['Money.add', 'method', 8, 10, false],
    ]);
    expect(p.symbols[1]!.signature).toBe('function round(n: number): number');
    expect(p.symbols[4]!.signature).toBe('add(other: Money): Money');
    expect(p.calls).toEqual(
      expect.arrayContaining([
        { from: 4, callee: 'Money', kind: 'new', line: 9 },
        { from: 4, callee: 'round', kind: 'call', line: 9 },
        { from: 1, callee: 'Math.round', kind: 'call', line: 2 },
      ]),
    );
  });

  it('records imports, re-exports, CommonJS requires and exports', async () => {
    const cart = await parseSource(REPO['src/cart.ts']!, 'typescript');
    expect(cart.imports.map((i) => [i.local, i.imported, i.source])).toEqual([
      ['Money', 'Money', './money.js'],
      ['round', 'round', './money.js'],
      ['util', '*', './util'],
      ['Base', 'Base', './base'],
      ['lodash', 'default', 'lodash'],
    ]);
    expect(cart.heritage).toEqual([{ from: 2, name: 'Base', kind: 'extends' }]);

    const index = await parseSource(REPO['src/index.ts']!, 'typescript');
    expect(index.reExports).toEqual([
      { exported: '*', imported: '*', source: './cart.js' },
      { exported: 'roundMoney', imported: 'round', source: './money.js' },
    ]);

    const legacy = await parseSource(REPO['lib/legacy.js']!, 'javascript');
    expect(legacy.imports.map((i) => [i.local, i.imported, i.source])).toEqual([
      ['round', 'round', '../src/money'],
      ['path', '*', 'path'],
    ]);
    expect(legacy.symbols.map((s) => [s.name, s.exported])).toEqual([
      ['<module>', false],
      ['fmt', false],
      ['helper', true],
    ]);
    expect(legacy.localExports).toEqual([{ local: 'fmt', exported: 'fmt' }]);
  });

  it('records JSX components as calls and anonymous default exports as symbols', async () => {
    const app = await parseSource(REPO['src/app.tsx']!, 'tsx');
    expect(app.symbols.map((s) => s.name)).toEqual(['<module>', 'App', 'Total']);
    expect(app.localExports).toEqual([{ local: 'App', exported: 'default' }]);
    expect(app.calls.map((c) => `${c.kind}:${c.callee}`)).toEqual(
      expect.arrayContaining(['new:Cart', 'call:roundMoney', 'jsx:Total']),
    );
    const anon = await parseSource('export default function () { go(); }\n', 'typescript');
    expect(anon.symbols[1]).toMatchObject({ name: 'default', kind: 'function', exported: true });
  });

  it('does not treat locals inside anonymous callbacks as module-level symbols', async () => {
    const p = await parseSource(
      `const top = 1;
test('x', async () => {
  const local = make();
  function helper() {}
});
`,
      'typescript',
    );
    expect(p.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'module:<module>',
      'variable:top',
      'function:helper',
    ]);
    expect(p.calls.map((c) => [c.callee, c.from])).toEqual([
      ['test', 0],
      ['make', 0],
    ]);
  });

  it('maps extensions to languages and skips declaration files', () => {
    expect(languageFor('a.ts')).toBe('typescript');
    expect(languageFor('a.tsx')).toBe('tsx');
    expect(languageFor('a.mjs')).toBe('javascript');
    expect(languageFor('a.d.ts')).toBeNull();
    expect(languageFor('a.py')).toBeNull();
  });
});

describe('RepoGraph', () => {
  it('indexes only source files outside vendored directories', async () => {
    const graph = await graphOf();
    expect(graph.paths).toEqual([
      'lib/legacy.js',
      'src/app.tsx',
      'src/base.ts',
      'src/cart.ts',
      'src/index.ts',
      'src/money.ts',
      'src/util/index.ts',
    ]);
  });

  it('resolves calls through imports, re-exports, namespaces, this and inheritance', async () => {
    const g = await graphOf();
    expect(edgesFrom(g, 'src/money.ts', 'Money.add')).toEqual([
      'calls src/money.ts:Money',
      'calls src/money.ts:round',
    ]);
    expect(edgesFrom(g, 'src/cart.ts', 'Cart.total')).toEqual([
      'calls src/money.ts:Money',
      'calls src/money.ts:round',
      'calls src/util/index.ts:sum',
    ]);
    // this.validate() is inherited from Base.
    expect(edgesFrom(g, 'src/cart.ts', 'Cart.add')).toEqual(['calls src/base.ts:Base.validate']);
    expect(edgesFrom(g, 'src/cart.ts', 'Cart')).toEqual(['extends src/base.ts:Base']);
    // Through `export *` and an aliased re-export, plus a JSX component.
    expect(edgesFrom(g, 'src/app.tsx', 'App')).toEqual([
      'calls src/app.tsx:Total',
      'calls src/cart.ts:Cart',
      'calls src/money.ts:round',
    ]);
    // CommonJS require with destructuring.
    expect(edgesFrom(g, 'lib/legacy.js', 'fmt')).toEqual(['calls src/money.ts:round']);
    expect(edgesFrom(g, 'lib/legacy.js', 'helper')).toEqual(['calls lib/legacy.js:fmt']);
  });

  it('records import edges and counts external imports', async () => {
    const g = await graphOf();
    expect(edgesFrom(g, 'src/cart.ts', '<module>')).toEqual([
      'imports src/base.ts:Base',
      'imports src/money.ts:Money',
      'imports src/money.ts:round',
      'imports src/util/index.ts:<module>',
    ]);
    // lodash (package) and path (built-in) are external.
    expect(g.stats.imports).toMatchObject({ total: 9, internal: 7, external: 2 });
    expect(g.stats.calls.resolved).toBeGreaterThan(0);
  });

  it('is deterministic regardless of file order', async () => {
    const reversed = Object.fromEntries(Object.entries(REPO).reverse());
    const a = await graphOf();
    const b = await graphOf(reversed);
    expect(b.edges).toEqual(a.edges);
    expect(b.symbols.map((s) => s.qualifiedName)).toEqual(a.symbols.map((s) => s.qualifiedName));
  });
});

describe('buildRepoGraph incremental parsing', () => {
  it('parses each blob once and re-parses only changed files', async () => {
    const cache = new MemoryParseCache();
    const first = await buildRepoGraph(memorySource(), cache);
    expect(first.stats).toMatchObject({ parsed: 7, fromCache: 0, filesIndexed: 7 });

    const changed = { ...REPO, 'src/money.ts': REPO['src/money.ts']!.replace('100', '1000') };
    const source = memorySource(changed);
    const second = await buildRepoGraph(source, cache);
    expect(second.stats).toMatchObject({ parsed: 1, fromCache: 6 });
    expect(source.reads).toEqual(['src/money.ts']);
  });

  it('computes git blob ids', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('changedSymbols', () => {
  it('maps added lines and pure deletions to innermost head symbols', async () => {
    const g = await graphOf();
    // Head lines: add() 13-16 (validate() on 14), blank 21 inside Cart, ok() from 22.
    const diff = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -13,4 +13,4 @@ export class Cart extends Base {
   add(line: Line) {
-    this.check();
+    this.validate();
     this.lines.push(line);
   }
@@ -20,5 +20,4 @@ export class Cart extends Base {
   }
 
-  // old comment
   ok() {
     return lodash.isArray(this.lines);
`;
    const changed = changedSymbols(g, parseUnifiedDiff(diff));
    expect(changed.map((c) => [c.symbol.qualifiedName, c.lines])).toEqual([
      ['Cart', [21]], // the deletion between total() and ok() belongs to the class
      ['Cart.add', [14]],
    ]);
  });
});

describe('assembleSymbolContext', () => {
  const opts = (budgetTokens: number, calleeDepth = 1, callerDepth = 0) => ({
    budgetTokens,
    calleeDepth,
    callerDepth,
    maxFullSymbolTokens: 2_000,
    readFile: async (p: string) => REPO[p] ?? null,
    estimateTokens: (t: string) => Math.ceil(t.length / 3),
  });

  async function seeds(g: RepoGraph) {
    return [{ symbol: sym(g, 'src/money.ts', 'Money.add'), lines: [9] }];
  }

  it('S3 shape: enclosing body, then direct callees', async () => {
    const g = await graphOf();
    const { sections, stats } = await assembleSymbolContext(g, await seeds(g), opts(10_000));
    expect(sections.map((s) => [s.qualifiedName, s.role, s.distance, s.mode])).toEqual([
      ['Money.add', 'enclosing', 0, 'full'],
      // Same distance and fan-in: ordered by position in the file.
      ['round', 'callee', 1, 'full'],
      ['Money', 'callee', 1, 'full'],
    ]);
    expect(sections[0]!.text).toContain(
      ' 9|     return new Money(round(this.value + other.value));',
    );
    expect(sections[2]!.text).toContain('relation="called by Money.add"');
    expect(stats.changedSymbols).toEqual(['src/money.ts:Money.add']);
  });

  it('S4 shape: callers and deeper hops, ranked by distance', async () => {
    const g = await graphOf();
    const seed = [{ symbol: sym(g, 'src/money.ts', 'round'), lines: [2] }];
    const { sections } = await assembleSymbolContext(g, seed, opts(10_000, 2, 2));
    expect(sections.map((s) => `${s.distance} ${s.role} ${s.path}:${s.qualifiedName}`)).toEqual([
      '0 enclosing src/money.ts:round',
      '1 caller lib/legacy.js:fmt',
      '1 caller src/app.tsx:App',
      '1 caller src/cart.ts:Cart.total',
      '1 caller src/money.ts:Money.add',
      '2 caller lib/legacy.js:helper',
    ]);
  });

  it('skips symbols already shown inside a containing symbol', async () => {
    const g = await graphOf();
    const seed = [
      { symbol: sym(g, 'src/money.ts', 'Money'), lines: [6] },
      { symbol: sym(g, 'src/money.ts', 'Money.add'), lines: [9] },
    ];
    const { sections } = await assembleSymbolContext(g, seed, opts(10_000));
    expect(sections.map((s) => s.qualifiedName)).toEqual(['Money', 'round']);
  });

  it('follows only calls on the changed lines for module-level changes', async () => {
    const files = {
      'src/lib.ts': 'export function a() {}\nexport function b() {}\n',
      'test/lib.test.ts': [
        "import { a, b } from '../src/lib';",
        "test('old', () => { a(); });",
        "test('new', () => { b(); });",
        '',
      ].join('\n'),
    };
    const g = await graphOf(files);
    const seed = [{ symbol: sym(g, 'test/lib.test.ts', '<module>'), lines: [3] }];
    const { sections } = await assembleSymbolContext(g, seed, {
      ...opts(10_000),
      readFile: async (p: string) => files[p as keyof typeof files] ?? null,
    });
    expect(sections.map((s) => `${s.role}:${s.qualifiedName}`)).toEqual(['callee:b']);
  });

  it('shows an excerpt around the change for large changed symbols', async () => {
    const body = Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const files = { 'src/big.ts': `export function big() {\n${body}\n}\n` };
    const g = await graphOf(files);
    const seed = [{ symbol: sym(g, 'src/big.ts', 'big'), lines: [41] }];
    const { sections } = await assembleSymbolContext(g, seed, {
      ...opts(10_000),
      maxFullSymbolTokens: 300,
      readFile: async (p: string) => files[p as keyof typeof files] ?? null,
    });
    expect(sections).toHaveLength(1);
    const s = sections[0]!;
    expect(s).toMatchObject({ mode: 'excerpt', startLine: 26, endLine: 56 });
    expect(s.text).toContain('shown="excerpt around the change"');
    expect(s.text).toContain(' 1| function big() …');
    expect(s.text).toContain('41|   const v39 = 39;');
    expect(s.text).not.toContain('const v70');
  });

  it('falls back to signatures, then omits, as the budget shrinks', async () => {
    const g = await graphOf();
    const roomy = await assembleSymbolContext(g, await seeds(g), opts(10_000));
    const enclosing = roomy.sections[0]!.tokens;
    const tight = await assembleSymbolContext(g, await seeds(g), opts(enclosing + 60));
    expect(tight.sections.map((s) => [s.qualifiedName, s.mode])).toEqual([
      ['Money.add', 'full'],
      ['round', 'signature'],
    ]);
    expect(tight.sections[1]!.text).toContain('shown="signature only"');
    expect(tight.stats.omitted).toBe(1);
    expect(tight.stats.tokens).toBeLessThanOrEqual(enclosing + 60);
  });
});
