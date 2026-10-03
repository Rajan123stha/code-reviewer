import { posix } from 'node:path';
import type { FileParse, ParsedSymbol } from './types.js';

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'implements';

export interface GraphSymbol extends ParsedSymbol {
  /** Global id: index into RepoGraph.symbols. */
  gid: number;
  path: string;
  /** Global id of the parent symbol, or null for modules. */
  parentGid: number | null;
}

export interface Edge {
  src: number;
  dst: number;
  kind: EdgeKind;
}

export interface ResolvedCallSite {
  line: number;
  src: number;
  dst: number;
}

export interface GraphStats {
  files: number;
  symbols: number;
  edges: Record<EdgeKind, number>;
  calls: { total: number; resolved: number; skippedByParser: number };
  imports: { total: number; internal: number; resolved: number; external: number };
}

/** Extensions tried when resolving a relative import, in order. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** `./x.js` in TypeScript sources usually means `./x.ts` (NodeNext style). */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const MAX_REEXPORT_DEPTH = 8;

/**
 * Whole-repository symbol graph linked from per-file parses. Resolution is static and
 * best-effort: relative imports, re-export chains, same-file names, `this.method`, static
 * and namespace member calls, and one level of inherited methods. ADR 0005 lists what is
 * out of reach (dynamic dispatch, path aliases, packages).
 *
 * Construction is deterministic: files are processed in sorted path order, so global ids,
 * edge order and everything derived from them are stable for a given set of files.
 */
export class RepoGraph {
  readonly symbols: GraphSymbol[] = [];
  readonly edges: Edge[] = [];
  readonly stats: GraphStats;
  private readonly byPath = new Map<string, GraphSymbol[]>();
  private readonly parses = new Map<string, FileParse>();
  private readonly out = new Map<number, Edge[]>();
  private readonly in = new Map<number, Edge[]>();
  private readonly exportCache = new Map<string, number | null>();
  private readonly callSitesByPath = new Map<string, ResolvedCallSite[]>();

  constructor(files: ReadonlyMap<string, FileParse>) {
    const paths = [...files.keys()].sort();
    for (const path of paths) {
      const parse = files.get(path)!;
      this.parses.set(path, parse);
      const offset = this.symbols.length;
      const list: GraphSymbol[] = parse.symbols.map((s) => ({
        ...s,
        gid: offset + s.id,
        path,
        parentGid: s.parent === null ? null : offset + s.parent,
      }));
      this.symbols.push(...list);
      this.byPath.set(path, list);
    }

    const stats: GraphStats = {
      files: paths.length,
      symbols: this.symbols.length,
      edges: { calls: 0, imports: 0, extends: 0, implements: 0 },
      calls: { total: 0, resolved: 0, skippedByParser: 0 },
      imports: { total: 0, internal: 0, resolved: 0, external: 0 },
    };
    const seen = new Set<string>();
    const addEdge = (src: number, dst: number, kind: EdgeKind) => {
      if (src === dst) return;
      const key = `${src}>${dst}>${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      const edge = { src, dst, kind };
      this.edges.push(edge);
      stats.edges[kind]++;
      push(this.out, src, edge);
      push(this.in, dst, edge);
    };

    for (const path of paths) {
      const parse = this.parses.get(path)!;
      const local = this.byPath.get(path)!;
      const moduleGid = local[0]!.gid;
      stats.calls.skippedByParser += parse.skippedCalls;

      for (const imp of parse.imports) {
        stats.imports.total++;
        const target = this.resolveModule(path, imp.source);
        if (target === undefined) {
          stats.imports.external++;
          continue;
        }
        stats.imports.internal++;
        const dst =
          imp.imported === '*'
            ? this.byPath.get(target)![0]!.gid
            : this.exported(target, imp.imported);
        if (dst !== null) {
          stats.imports.resolved++;
          addEdge(moduleGid, dst, 'imports');
        }
      }

      for (const h of parse.heritage) {
        const dst = this.resolveName(path, h.name);
        if (dst !== null) addEdge(local[h.from]!.gid, dst, h.kind);
      }
    }

    // Calls last: `this.m()` on inherited methods needs extends edges in place.
    for (const path of paths) {
      const parse = this.parses.get(path)!;
      const local = this.byPath.get(path)!;
      for (const call of parse.calls) {
        stats.calls.total++;
        const from = local[call.from]!;
        const dst = this.resolveCall(path, from, call.callee);
        if (dst !== null) {
          stats.calls.resolved++;
          addEdge(from.gid, dst, 'calls');
          push(this.callSitesByPath, path, { line: call.line, src: from.gid, dst });
        }
      }
    }
    this.stats = stats;
  }

  get paths(): string[] {
    return [...this.byPath.keys()];
  }

  symbolsIn(path: string): readonly GraphSymbol[] {
    return this.byPath.get(path) ?? [];
  }

  /** Resolved call sites in a file on the given lines, in source order. */
  callsOnLines(path: string, lines: ReadonlySet<number>): readonly ResolvedCallSite[] {
    return (this.callSitesByPath.get(path) ?? []).filter((c) => lines.has(c.line));
  }

  outgoing(gid: number): readonly Edge[] {
    return this.out.get(gid) ?? [];
  }

  incoming(gid: number): readonly Edge[] {
    return this.in.get(gid) ?? [];
  }

  /** Innermost non-module symbol whose range contains the line, or the module symbol. */
  symbolAt(path: string, line: number): GraphSymbol | undefined {
    const list = this.byPath.get(path);
    if (!list) return undefined;
    let best = list[0];
    for (const s of list) {
      if (s.kind === 'module' || line < s.startLine || line > s.endLine) continue;
      if (
        !best ||
        best.kind === 'module' ||
        s.endLine - s.startLine <= best.endLine - best.startLine
      )
        best = s;
    }
    return best;
  }

  /** Resolve a relative module specifier to an indexed path; undefined for packages/missing. */
  resolveModule(fromPath: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    const candidates = [base];
    const ext = posix.extname(base);
    for (const alt of JS_TO_TS[ext] ?? []) candidates.push(base.slice(0, -ext.length) + alt);
    for (const e of RESOLVE_EXTENSIONS) candidates.push(base + e);
    for (const e of RESOLVE_EXTENSIONS) candidates.push(`${base}/index${e}`);
    return candidates.find((c) => this.byPath.has(c));
  }

  /** Global id of the symbol a module exports under `name`, following re-exports. */
  exported(path: string, name: string, depth = 0): number | null {
    const key = `${path}\0${name}`;
    if (this.exportCache.has(key)) return this.exportCache.get(key)!;
    if (depth > MAX_REEXPORT_DEPTH) return null;
    this.exportCache.set(key, null); // cycle guard
    const result = this.computeExported(path, name, depth);
    this.exportCache.set(key, result);
    return result;
  }

  private computeExported(path: string, name: string, depth: number): number | null {
    const parse = this.parses.get(path);
    const local = this.byPath.get(path);
    if (!parse || !local) return null;

    const alias = parse.localExports.find((e) => e.exported === name);
    if (alias) {
      const target = this.topLevel(path, alias.local);
      if (target !== null) return target;
      const imported = this.importedName(path, alias.local);
      if (imported !== null) return imported;
    }
    if (name !== 'default') {
      const direct = local.find((s) => s.exported && s.parent === 0 && s.name === name);
      if (direct) return direct.gid;
    }
    for (const re of parse.reExports) {
      const target = this.resolveModule(path, re.source);
      if (target === undefined) continue;
      if (re.exported === name) {
        return re.imported === '*'
          ? this.byPath.get(target)![0]!.gid
          : this.exported(target, re.imported, depth + 1);
      }
      if (re.exported === '*' && name !== 'default') {
        const found = this.exported(target, name, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  }

  private topLevel(path: string, name: string): number | null {
    const s = this.byPath.get(path)?.find((x) => x.parent === 0 && x.name === name);
    return s ? s.gid : null;
  }

  /** Symbol bound to a local name by an import in `path`. Namespace imports give the module. */
  private importedName(path: string, name: string): number | null {
    const imp = this.parses.get(path)?.imports.find((i) => i.local === name);
    if (!imp) return null;
    const target = this.resolveModule(path, imp.source);
    if (target === undefined) return null;
    return imp.imported === '*'
      ? this.byPath.get(target)![0]!.gid
      : this.exported(target, imp.imported);
  }

  /** A bare or dotted name as seen from `path`: same-file top level first, then imports. */
  resolveName(path: string, name: string): number | null {
    const [head, member] = name.split('.', 2) as [string, string | undefined];
    const base = this.topLevel(path, head) ?? this.importedName(path, head);
    if (base === null || member === undefined) return base;
    return this.memberOf(base, member);
  }

  /** `X.member` where X is a module (namespace import) or a class (static member). */
  private memberOf(gid: number, member: string): number | null {
    const sym = this.symbols[gid]!;
    if (sym.kind === 'module') return this.exported(sym.path, member);
    if (sym.kind === 'class') return this.methodOf(gid, member);
    return null;
  }

  /** Method `name` on a class, or on its direct superclass. */
  private methodOf(classGid: number, name: string, depth = 0): number | null {
    const cls = this.symbols[classGid]!;
    const own = this.byPath.get(cls.path)!.find((s) => s.parentGid === classGid && s.name === name);
    if (own) return own.gid;
    if (depth >= 1) return null;
    const base = this.outgoing(classGid).find((e) => e.kind === 'extends');
    return base ? this.methodOf(base.dst, name, depth + 1) : null;
  }

  private resolveCall(path: string, from: GraphSymbol, callee: string): number | null {
    if (callee.startsWith('this.')) {
      let cls: GraphSymbol | undefined = from;
      while (cls && cls.kind !== 'class')
        cls = cls.parentGid === null ? undefined : this.symbols[cls.parentGid];
      return cls ? this.methodOf(cls.gid, callee.slice(5)) : null;
    }
    const target = this.resolveName(path, callee);
    if (target === null) return null;
    // `new Foo()` and calls on a class name land on the class itself.
    return target;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
