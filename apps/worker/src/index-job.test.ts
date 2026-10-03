import { gitBlobSha, MemoryParseCache } from '@reviewlens/context-engine';
import type { GitHubClient } from '@reviewlens/github';
import { createLogger, type IndexJobData } from '@reviewlens/shared';
import { describe, expect, it, vi } from 'vitest';
import { processIndexJob, type IndexDeps } from './index-job.js';

const FILES: Record<string, string> = {
  'src/a.ts': "import { b } from './b';\nexport const a = () => b();\n",
  'src/b.ts': 'export function b() {\n  return 1;\n}\n',
  'README.md': '# hi\n',
};
const SHA = 'a'.repeat(40);
const job: IndexJobData = {
  deliveryId: 'd',
  installationId: 1,
  repositoryId: 2,
  owner: 'o',
  repo: 'r',
  sha: SHA,
};

function fakeGitHub() {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/trees')) {
      return {
        data: {
          truncated: false,
          tree: Object.entries(FILES).map(([path, c]) => ({
            path,
            type: 'blob',
            mode: '100644',
            sha: gitBlobSha(c),
            size: c.length,
          })),
        },
      };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/contents'))
      return { data: FILES[params.path as string] };
    throw new Error(`unexpected ${route}`);
  });
  return { client: { request } as unknown as GitHubClient, request };
}

describe('processIndexJob', () => {
  it('indexes the commit, reads only uncached source files, and persists the graph', async () => {
    const gh = fakeGitHub();
    const persistIndex = vi.fn<IndexDeps['persistIndex']>(async ({ graph }) => ({
      filesKept: 0,
      filesWritten: graph.paths.length,
      filesDeleted: 0,
      symbolsWritten: graph.symbols.length,
      edges: graph.edges.length,
    }));
    const deps: IndexDeps = {
      getClient: async () => gh.client,
      parseCache: new MemoryParseCache(),
      upsertRepository: vi.fn(async () => 7),
      persistIndex,
      logger: createLogger('test', { level: 'silent' }),
    };

    const first = await processIndexJob(job, deps);
    expect(first.stats).toMatchObject({ filesIndexed: 2, parsed: 2 });
    expect(persistIndex.mock.calls[0]![0]).toMatchObject({ repositoryId: 7, sha: SHA });
    expect(persistIndex.mock.calls[0]![0].graph.edges.map((e) => e.kind).sort()).toEqual([
      'calls',
      'imports',
    ]);
    const contentReads = () =>
      gh.request.mock.calls.filter(([r]) => r.includes('/contents/')).length;
    expect(contentReads()).toBe(2); // README.md is never read

    const second = await processIndexJob(job, deps);
    expect(second.stats).toMatchObject({ parsed: 0, fromCache: 2 });
    expect(contentReads()).toBe(2);
  });
});
