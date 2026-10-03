import {
  assembleSymbolContext,
  buildRepoGraph,
  changedSymbols,
  MemoryParseCache,
  type ParseCache,
} from '@reviewlens/context-engine';
import type { FileDiff } from '@reviewlens/github';
import type { StrategyConfig } from './config.js';
import type { BuiltContext } from './context.js';
import type { RepoSnapshot } from './input.js';
import { estimateTokens } from './tokens.js';

/**
 * Append symbol sections (S3, S4) to an already-built diff context, spending only what the
 * diffs left of the budget. The graph is built from the whole head snapshot; the parse
 * cache only makes that cheaper, never different.
 */
export async function addSymbolContext(
  context: BuiltContext,
  args: {
    config: StrategyConfig;
    head: RepoSnapshot;
    /** Diff files whose diffs made it into the context. */
    files: FileDiff[];
    readScrubbed: (path: string) => Promise<string | null>;
    parseCache?: ParseCache | undefined;
  },
): Promise<void> {
  const { config, head } = args;
  if (!head.listFiles) {
    throw new Error(`strategy ${config.strategy} needs a snapshot that can list files`);
  }
  const { graph, stats: index } = await buildRepoGraph(
    { listFiles: () => head.listFiles!(), readFile: (p) => head.readFile(p) },
    args.parseCache ?? new MemoryParseCache(),
  );
  const changed = changedSymbols(graph, args.files);
  const depth =
    config.strategy === 'S3'
      ? { calleeDepth: 1, callerDepth: 0 }
      : { calleeDepth: config.graphDepth, callerDepth: config.graphDepth };
  const { sections, stats } = await assembleSymbolContext(graph, changed, {
    ...depth,
    budgetTokens: context.stats.budget - context.stats.estimatedTokens,
    maxFullSymbolTokens: config.maxSymbolTokens,
    readFile: args.readScrubbed,
    estimateTokens,
  });

  for (const s of sections) {
    context.sections.push({ kind: 'symbol', path: s.path, text: s.text, tokens: s.tokens });
  }
  context.stats.estimatedTokens += stats.tokens;
  context.stats.symbols = {
    index,
    graph: {
      symbols: graph.stats.symbols,
      edges: graph.edges.length,
      callsResolved: graph.stats.calls.resolved,
      callsTotal: graph.stats.calls.total,
    },
    changedSymbols: stats.changedSymbols,
    included: sections.map((s) => ({
      name: `${s.path}:${s.qualifiedName}`,
      role: s.role,
      distance: s.distance,
      mode: s.mode,
    })),
    signatureOnly: stats.signatureOnly,
    omitted: stats.omitted,
    tokens: stats.tokens,
  };
}
