import {
  buildRepoGraph,
  gitBlobSha,
  MemoryParseCache,
  type FileParse,
} from '@reviewlens/context-engine';
import { describe, expect, it } from 'vitest';
import { DbParseCache, persistRepoIndex } from './repo-index.js';
import { upsertPullRequest } from './reviews.js';
import { useTestDb } from './test-db.js';

const getDb = useTestDb();

const FILES: Record<string, string> = {
  'src/a.ts': "import { b } from './b';\nexport class A {\n  run() {\n    return b();\n  }\n}\n",
  'src/b.ts': 'export function b() {\n  return 1;\n}\n',
  'src/c.ts': "import { A } from './a';\nexport const c = () => new A().run();\n",
};

function source(files: Record<string, string>) {
  return {
    entries: Object.entries(files).map(([path, content]) => ({
      path,
      blobSha: gitBlobSha(content),
    })),
    listFiles: async () =>
      Object.entries(files).map(([path, content]) => ({ path, blobSha: gitBlobSha(content) })),
    readFile: async (path: string) => files[path] ?? null,
  };
}

async function repoId() {
  const db = getDb();
  const prId = await upsertPullRequest(db, {
    installation: { githubId: 1, account: 'o' },
    repository: { githubId: 2, fullName: 'o/r' },
    pullRequest: { number: 1, title: 't', headSha: 'h', baseSha: 'b' },
  });
  return (await db.pullRequest.findUniqueOrThrow({ where: { id: prId } })).repositoryId;
}

async function persist(files: Record<string, string>, sha: string) {
  const db = getDb();
  const src = source(files);
  const { graph } = await buildRepoGraph(src, new MemoryParseCache());
  const result = await persistRepoIndex(db, {
    repositoryId: await repoId(),
    sha,
    graph,
    entries: src.entries,
  });
  return { graph, result };
}

describe('persistRepoIndex', () => {
  it('stores files, symbols with parents, and edges', async () => {
    const db = getDb();
    const { graph, result } = await persist(FILES, 'sha1');
    expect(result).toEqual({
      filesKept: 0,
      filesWritten: 3,
      filesDeleted: 0,
      symbolsWritten: graph.symbols.length,
      edges: graph.edges.length,
    });
    const run = await db.codeSymbol.findFirstOrThrow({
      where: { qualifiedName: 'A.run' },
      include: { outgoing: { include: { dst: true } } },
    });
    expect(run.parentSymbolId).not.toBeNull();
    const parent = await db.codeSymbol.findUniqueOrThrow({ where: { id: run.parentSymbolId! } });
    expect(parent.qualifiedName).toBe('A');
    expect(run.outgoing.map((e) => `${e.kind}:${e.dst.qualifiedName}`)).toEqual(['calls:b']);
    const repo = await db.repository.findFirstOrThrow();
    expect(repo.lastIndexedSha).toBe('sha1');
  });

  it('rewrites only changed and deleted files on re-index', async () => {
    const db = getDb();
    await persist(FILES, 'sha1');
    const before = await db.repoFile.findFirstOrThrow({ where: { path: 'src/b.ts' } });

    const next: Record<string, string> = {
      ...FILES,
      'src/a.ts': FILES['src/a.ts']!.replace('return b();', 'return b() + 1;'),
    };
    delete next['src/c.ts'];
    const { graph, result } = await persist(next, 'sha2');
    expect(result).toMatchObject({ filesKept: 1, filesWritten: 1, filesDeleted: 2 });
    const after = await db.repoFile.findFirstOrThrow({ where: { path: 'src/b.ts' } });
    expect(after.id).toBe(before.id); // untouched row kept
    expect(await db.repoFile.count()).toBe(2);
    expect(await db.symbolEdge.count()).toBe(graph.edges.length);
  });
});

describe('DbParseCache', () => {
  it('round-trips parses and ignores duplicate writes', async () => {
    const cache = new DbParseCache(getDb());
    const parse: FileParse = {
      parserVersion: 2,
      language: 'typescript',
      lineCount: 1,
      symbols: [],
      imports: [],
      reExports: [],
      localExports: [],
      calls: [],
      heritage: [],
      skippedCalls: 0,
    };
    expect(await cache.get('k')).toBeUndefined();
    await cache.set('k', parse);
    await cache.set('k', parse);
    expect(await cache.get('k')).toEqual(parse);
  });
});
