import {
  languageFor,
  PARSER_VERSION,
  type FileParse,
  type ParseCache,
  type RepoFileEntry,
  type RepoGraph,
} from '@reviewlens/context-engine';
import type { Db } from './client.js';
import type { Prisma } from './generated/prisma/client.js';

/** Parse cache in Postgres, shared by every repository (keys are content addresses). */
export class DbParseCache implements ParseCache {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<FileParse | undefined> {
    const row = await this.db.parsedBlob.findUnique({ where: { key } });
    return row ? (row.parse as unknown as FileParse) : undefined;
  }

  async set(key: string, parse: FileParse): Promise<void> {
    await this.db.parsedBlob.createMany({
      data: [{ key, parse: parse as unknown as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
  }
}

export interface PersistIndexResult {
  filesKept: number;
  filesWritten: number;
  filesDeleted: number;
  symbolsWritten: number;
  edges: number;
}

const CHUNK = 5_000;

/**
 * Store a repository's symbol graph at `sha` (normally the default branch head) in the
 * files/symbols/edges tables. Incremental by blob hash: rows for files whose contents and
 * parser version are unchanged are kept; changed and deleted files are rewritten. Edges
 * depend on cross-file resolution, so they are rebuilt for the whole repository.
 */
export async function persistRepoIndex(
  db: Db,
  args: { repositoryId: number; sha: string; graph: RepoGraph; entries: readonly RepoFileEntry[] },
): Promise<PersistIndexResult> {
  const { repositoryId, graph } = args;
  const blobByPath = new Map(args.entries.map((e) => [e.path, e.blobSha]));
  const indexed = graph.paths;
  const indexedSet = new Set(indexed);

  return db.$transaction(
    async (tx) => {
      const existing = await tx.repoFile.findMany({ where: { repositoryId } });
      const keep = new Map<string, number>();
      const stale: number[] = [];
      for (const f of existing) {
        const current = blobByPath.get(f.path);
        if (
          indexedSet.has(f.path) &&
          current === f.blobHash &&
          f.parserVersion === PARSER_VERSION
        ) {
          keep.set(f.path, f.id);
        } else {
          stale.push(f.id);
        }
      }
      // Cascades to the stale files' symbols and any edges touching them.
      if (stale.length) await tx.repoFile.deleteMany({ where: { id: { in: stale } } });
      await tx.symbolEdge.deleteMany({ where: { repositoryId } });

      const toWrite = indexed.filter((p) => !keep.has(p));
      const fileIds = new Map(keep);
      if (toWrite.length) {
        await tx.repoFile.createMany({
          data: toWrite.map((path) => ({
            repositoryId,
            path,
            language: languageFor(path) ?? 'unknown',
            blobHash: blobByPath.get(path) ?? '',
            parserVersion: PARSER_VERSION,
          })),
        });
        const written = await tx.repoFile.findMany({
          where: { repositoryId, path: { in: toWrite } },
          select: { id: true, path: true },
        });
        for (const f of written) fileIds.set(f.path, f.id);
      }

      // Symbols for new/changed files; parents are linked in a second pass by local index.
      const newSymbols = toWrite.flatMap((path) =>
        graph.symbolsIn(path).map((s) => ({ fileId: fileIds.get(path)!, s })),
      );
      for (let i = 0; i < newSymbols.length; i += CHUNK) {
        await tx.codeSymbol.createMany({
          data: newSymbols.slice(i, i + CHUNK).map(({ fileId, s }) => ({
            fileId,
            localIndex: s.id,
            name: s.name,
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            signature: s.signature,
            exported: s.exported,
          })),
        });
      }
      const withParent = newSymbols.filter(({ s }) => s.parent !== null);
      if (withParent.length) {
        await tx.$executeRaw`
          UPDATE symbols AS c SET parent_symbol_id = p.id
          FROM unnest(
            ${withParent.map((x) => x.fileId)}::int[],
            ${withParent.map((x) => x.s.id)}::int[],
            ${withParent.map((x) => x.s.parent!)}::int[]
          ) AS v(file_id, child, parent)
          JOIN symbols AS p ON p.file_id = v.file_id AND p.local_index = v.parent
          WHERE c.file_id = v.file_id AND c.local_index = v.child`;
      }

      // Map graph ids to database ids, then write every edge.
      const rows = await tx.codeSymbol.findMany({
        where: { file: { repositoryId } },
        select: { id: true, fileId: true, localIndex: true },
      });
      const dbId = new Map(rows.map((r) => [`${r.fileId}:${r.localIndex}`, r.id]));
      const idOf = (gid: number) => {
        const s = graph.symbols[gid]!;
        return dbId.get(`${fileIds.get(s.path)}:${s.id}`);
      };
      const edges = graph.edges.flatMap((e) => {
        const src = idOf(e.src);
        const dst = idOf(e.dst);
        return src && dst
          ? [{ repositoryId, srcSymbolId: src, dstSymbolId: dst, kind: e.kind }]
          : [];
      });
      for (let i = 0; i < edges.length; i += CHUNK) {
        await tx.symbolEdge.createMany({ data: edges.slice(i, i + CHUNK) });
      }

      await tx.repository.update({
        where: { id: repositoryId },
        data: { lastIndexedSha: args.sha },
      });
      return {
        filesKept: keep.size,
        filesWritten: toWrite.length,
        filesDeleted: stale.length,
        symbolsWritten: newSymbols.length,
        edges: edges.length,
      };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
