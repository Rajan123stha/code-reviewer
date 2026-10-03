import type { ChangedSymbol } from './diff-map.js';
import type { EdgeKind, GraphSymbol, RepoGraph } from './graph.js';

export type ContextRole = 'enclosing' | 'callee' | 'base' | 'caller';

export interface SymbolContextOptions {
  /** Token budget for symbol sections (what the diff left over). */
  budgetTokens: number;
  /** Hops along outgoing calls/extends/implements edges from the changed symbols. */
  calleeDepth: number;
  /** Hops along incoming call edges. */
  callerDepth: number;
  /** Bodies above this many tokens are shown as their signature only. */
  maxFullSymbolTokens: number;
  /** Head contents of a file (already scrubbed), or null if unavailable. */
  readFile(path: string): Promise<string | null>;
  estimateTokens(text: string): number;
}

export interface SymbolSection {
  gid: number;
  path: string;
  qualifiedName: string;
  role: ContextRole;
  distance: number;
  /** Changed symbol this one is related to (the first, in seed order). */
  relatedTo: string;
  mode: 'full' | 'excerpt' | 'signature';
  startLine: number;
  endLine: number;
  text: string;
  tokens: number;
}

export interface SymbolContextStats {
  changedSymbols: string[];
  candidates: number;
  included: number;
  signatureOnly: number;
  omitted: number;
  tokens: number;
}

interface Candidate {
  symbol: GraphSymbol;
  role: ContextRole;
  distance: number;
  /** Number of distinct changed symbols that reach this one: shared dependencies rank higher. */
  fanIn: number;
  relatedTo: string;
  /** Changed lines, for excerpts of large enclosing symbols. */
  focus?: number[];
}

const ROLE_ORDER: Record<ContextRole, number> = { enclosing: 0, callee: 1, base: 1, caller: 2 };
/** Context lines kept on each side of the change in an excerpt. */
const EXCERPT_LINES = 15;
const CALLEE_EDGES: ReadonlySet<EdgeKind> = new Set(['calls', 'extends', 'implements']);

/**
 * Repository context around the changed symbols, ranked by graph distance:
 *
 * 1. enclosing: the changed symbols' own bodies (distance 0);
 * 2. callee/base: definitions they call or extend, out to `calleeDepth`;
 * 3. caller: code that calls them, out to `callerDepth`.
 *
 * Within a distance, callees come before callers, then symbols reached from more changed
 * symbols, then path and line. Each symbol is shown whole, or as its signature when the
 * body is large or the budget is short, or left out. A symbol inside one already shown is
 * skipped. Deterministic for a given graph, diff and budget.
 */
export async function assembleSymbolContext(
  graph: RepoGraph,
  changed: readonly ChangedSymbol[],
  options: SymbolContextOptions,
): Promise<{ sections: SymbolSection[]; stats: SymbolContextStats }> {
  const candidates = rankCandidates(graph, changed, options);
  const sections: SymbolSection[] = [];
  const stats: SymbolContextStats = {
    changedSymbols: changed.map((c) => `${c.symbol.path}:${c.symbol.qualifiedName}`),
    candidates: candidates.length,
    included: 0,
    signatureOnly: 0,
    omitted: 0,
    tokens: 0,
  };
  const files = new Map<string, string[] | null>();
  const lines = async (path: string) => {
    if (!files.has(path)) {
      const content = await options.readFile(path);
      files.set(path, content === null ? null : content.replace(/\r\n/g, '\n').split('\n'));
    }
    return files.get(path)!;
  };
  let remaining = options.budgetTokens;

  for (const c of candidates) {
    const s = c.symbol;
    const covered = sections.some(
      (x) =>
        x.path === s.path &&
        x.mode === 'full' &&
        x.startLine <= s.startLine &&
        x.endLine >= s.endLine,
    );
    if (covered) continue;
    const content = await lines(s.path);
    if (!content) {
      stats.omitted++;
      continue;
    }
    const shown = {
      full: '',
      excerpt: ' shown="excerpt around the change"',
      signature: ' shown="signature only"',
    };
    const header = (mode: SymbolSection['mode']) =>
      `<symbol path="${attr(s.path)}" name="${attr(s.qualifiedName)}" kind="${s.kind}" lines="${s.startLine}-${s.endLine}" relation="${relation(c)}"${shown[mode]}>`;
    const width = String(s.endLine).length;
    const numbered = (from: number, to: number) =>
      content
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(width)}| ${l}`)
        .join('\n');
    const full = `${header('full')}\n${numbered(s.startLine, s.endLine)}\n</symbol>`;
    const fullTokens = options.estimateTokens(full);
    if (fullTokens <= options.maxFullSymbolTokens && fullTokens <= remaining) {
      sections.push(section(c, 'full', full, fullTokens));
      remaining -= fullTokens;
      stats.included++;
      continue;
    }
    // A changed symbol too large to show whole: its signature plus the lines around the
    // change, which is the part the reviewer needs most.
    if (c.focus?.length) {
      const from = Math.max(s.startLine, Math.min(...c.focus) - EXCERPT_LINES);
      const to = Math.min(s.endLine, Math.max(...c.focus) + EXCERPT_LINES);
      const lead =
        from > s.startLine
          ? `${String(s.startLine).padStart(width)}| ${s.signature} …\n${' '.repeat(width)}| …\n`
          : '';
      const tail = to < s.endLine ? `\n${' '.repeat(width)}| …` : '';
      const excerpt = `${header('excerpt')}\n${lead}${numbered(from, to)}${tail}\n</symbol>`;
      const excerptTokens = options.estimateTokens(excerpt);
      if (excerptTokens <= options.maxFullSymbolTokens && excerptTokens <= remaining) {
        sections.push({
          ...section(c, 'excerpt', excerpt, excerptTokens),
          startLine: from,
          endLine: to,
        });
        remaining -= excerptTokens;
        stats.included++;
        continue;
      }
    }
    const sig = `${header('signature')}\n${String(s.startLine).padStart(width)}| ${s.signature || content[s.startLine - 1]?.trim() || ''} …\n</symbol>`;
    const sigTokens = options.estimateTokens(sig);
    if (sigTokens <= remaining) {
      sections.push(section(c, 'signature', sig, sigTokens));
      remaining -= sigTokens;
      stats.included++;
      stats.signatureOnly++;
    } else {
      stats.omitted++;
    }
  }
  stats.tokens = options.budgetTokens - remaining;
  return { sections, stats };
}

function rankCandidates(
  graph: RepoGraph,
  changed: readonly ChangedSymbol[],
  options: Pick<SymbolContextOptions, 'calleeDepth' | 'callerDepth'>,
): Candidate[] {
  const best = new Map<number, Candidate>();
  const reachedBy = new Map<number, Set<number>>();
  const offer = (
    symbol: GraphSymbol,
    role: ContextRole,
    distance: number,
    seed: GraphSymbol,
    focus?: number[],
  ) => {
    if (symbol.kind === 'module') return;
    let seeds = reachedBy.get(symbol.gid);
    if (!seeds) reachedBy.set(symbol.gid, (seeds = new Set()));
    seeds.add(seed.gid);
    const current = best.get(symbol.gid);
    const better =
      !current ||
      distance < current.distance ||
      (distance === current.distance && ROLE_ORDER[role] < ROLE_ORDER[current.role]);
    if (better) {
      best.set(symbol.gid, {
        symbol,
        role,
        distance,
        fanIn: 0,
        relatedTo: seed.qualifiedName,
        ...(focus ? { focus } : {}),
      });
    }
  };

  for (const { symbol: seed, lines } of changed) {
    if (seed.kind === 'module') {
      // Module-level changes (top-level statements, test blocks) follow only the calls on
      // the changed lines; the module's every call would flood the context.
      if (options.calleeDepth < 1) continue;
      const direct = graph.callsOnLines(seed.path, new Set(lines));
      for (const call of direct) offer(graph.symbols[call.dst]!, 'callee', 1, seed);
      walkFrom(
        graph,
        direct.map((c) => c.dst),
        1,
        options.calleeDepth,
        'out',
        (s, d, kind) => offer(s, kind === 'calls' ? 'callee' : 'base', d, seed),
      );
      continue;
    }
    offer(seed, 'enclosing', 0, seed, lines);
    walkFrom(graph, [seed.gid], 0, options.calleeDepth, 'out', (s, d, kind) =>
      offer(s, kind === 'calls' ? 'callee' : 'base', d, seed),
    );
    walkFrom(graph, [seed.gid], 0, options.callerDepth, 'in', (s, d) =>
      offer(s, 'caller', d, seed),
    );
  }
  for (const c of best.values()) c.fanIn = reachedBy.get(c.symbol.gid)?.size ?? 1;

  return [...best.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      b.fanIn - a.fanIn ||
      (a.symbol.path < b.symbol.path ? -1 : a.symbol.path > b.symbol.path ? 1 : 0) ||
      a.symbol.startLine - b.symbol.startLine ||
      a.symbol.gid - b.symbol.gid,
  );
}

/**
 * Breadth-first walk from `start` (already at distance `startDistance`) out to `depth`;
 * each symbol is visited once, at its shortest distance.
 */
function walkFrom(
  graph: RepoGraph,
  start: number[],
  startDistance: number,
  depth: number,
  direction: 'out' | 'in',
  visit: (symbol: GraphSymbol, distance: number, kind: EdgeKind) => void,
) {
  let frontier = [...new Set(start)];
  const seen = new Set(frontier);
  for (let d = startDistance + 1; d <= depth && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const gid of frontier) {
      const edges = direction === 'out' ? graph.outgoing(gid) : graph.incoming(gid);
      for (const e of edges) {
        if (direction === 'out' ? !CALLEE_EDGES.has(e.kind) : e.kind !== 'calls') continue;
        const other = direction === 'out' ? e.dst : e.src;
        if (seen.has(other)) continue;
        seen.add(other);
        visit(graph.symbols[other]!, d, e.kind);
        next.push(other);
      }
    }
    frontier = next;
  }
}

function section(
  c: Candidate,
  mode: SymbolSection['mode'],
  text: string,
  tokens: number,
): SymbolSection {
  return {
    gid: c.symbol.gid,
    path: c.symbol.path,
    qualifiedName: c.symbol.qualifiedName,
    role: c.role,
    distance: c.distance,
    relatedTo: c.relatedTo,
    mode,
    startLine: c.symbol.startLine,
    endLine: c.symbol.endLine,
    text,
    tokens,
  };
}

function relation(c: Candidate): string {
  switch (c.role) {
    case 'enclosing':
      return 'changed in this diff';
    case 'callee':
      return `called by ${c.relatedTo}${c.distance > 1 ? ` (${c.distance} hops)` : ''}`;
    case 'base':
      return `extended or implemented by ${c.relatedTo}${c.distance > 1 ? ` (${c.distance} hops)` : ''}`;
    case 'caller':
      return `calls ${c.relatedTo}${c.distance > 1 ? ` (${c.distance} hops)` : ''}`;
  }
}

function attr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
