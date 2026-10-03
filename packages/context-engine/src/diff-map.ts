import type { FileDiff } from '@reviewlens/github';
import type { GraphSymbol, RepoGraph } from './graph.js';

export interface ChangedSymbol {
  symbol: GraphSymbol;
  /** New-file lines within the symbol that were added, or next to a deletion. */
  lines: number[];
}

/**
 * Map a diff to the head-side symbols it touches. Added lines map to the innermost symbol
 * containing them. A deletion with no added lines maps through the new-side line where the
 * removed code used to be. Module-level changes map to the module symbol.
 *
 * Output is sorted by path and position, so it is deterministic.
 */
export function changedSymbols(graph: RepoGraph, files: readonly FileDiff[]): ChangedSymbol[] {
  const byGid = new Map<number, Set<number>>();
  for (const file of files) {
    if (file.newPath === null || file.binary) continue;
    const path = file.newPath;
    if (graph.symbolsIn(path).length === 0) continue;

    // A pure deletion is anchored to the head line just before where the removed code was
    // (so a deletion between two methods lands in the class, not the next method), or to
    // the line just after it when it starts the file.
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      let previous: number | null = hunk.newStart > 1 ? hunk.newStart - 1 : null;
      let pendingDeletion = false;
      for (const line of hunk.lines) {
        if (line.type === 'add' && line.newLine !== undefined) {
          lines.add(line.newLine);
          pendingDeletion = false;
          previous = line.newLine;
        } else if (line.type === 'context' && line.newLine !== undefined) {
          if (pendingDeletion) lines.add(previous ?? line.newLine);
          pendingDeletion = false;
          previous = line.newLine;
        } else if (line.type === 'del') {
          pendingDeletion = true;
        }
      }
      if (pendingDeletion && previous !== null) lines.add(previous);
    }

    for (const line of lines) {
      const symbol = graph.symbolAt(path, line);
      if (!symbol) continue;
      let set = byGid.get(symbol.gid);
      if (!set) byGid.set(symbol.gid, (set = new Set()));
      set.add(line);
    }
  }

  return [...byGid.entries()]
    .map(([gid, lines]) => ({
      symbol: graph.symbols[gid]!,
      lines: [...lines].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.symbol.gid - b.symbol.gid);
}
