import { SEVERITY_RANK, type ModelComment } from './schema.js';
import { normalizePath } from './validate.js';

/** Lines apart within which two comments on the same file can be duplicates. */
const LINE_WINDOW = 3;
/** Claim word-set overlap (Jaccard) at or above which nearby comments are duplicates. */
const CLAIM_SIMILARITY = 0.5;

/** Higher priority first: severity, then confidence, then location for a stable order. */
export function compareComments(a: ModelComment, b: ModelComment): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.confidence - a.confidence ||
    normalizePath(a.file).localeCompare(normalizePath(b.file)) ||
    a.line - b.line
  );
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export function isDuplicate(a: ModelComment, b: ModelComment): boolean {
  if (normalizePath(a.file) !== normalizePath(b.file)) return false;
  if (Math.abs(a.line - b.line) > LINE_WINDOW) return false;
  if (a.line === b.line && a.category === b.category) return true;
  return jaccard(words(a.claim), words(b.claim)) >= CLAIM_SIMILARITY;
}

/**
 * Greedy near-duplicate removal over comments in priority order. Returns, for each input
 * index, the index of the kept comment it duplicates, or null if it is kept itself.
 */
export function findDuplicates(comments: ModelComment[]): (number | null)[] {
  const order = comments
    .map((_, i) => i)
    .sort((i, j) => compareComments(comments[i]!, comments[j]!));
  const kept: number[] = [];
  const duplicateOf: (number | null)[] = comments.map(() => null);
  for (const i of order) {
    const match = kept.find((k) => isDuplicate(comments[k]!, comments[i]!));
    if (match === undefined) kept.push(i);
    else duplicateOf[i] = match;
  }
  return duplicateOf;
}
