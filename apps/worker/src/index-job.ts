import {
  buildRepoGraph,
  type ParseCache,
  type RepoFileEntry,
  type RepoGraph,
} from '@reviewlens/context-engine';
import type { PersistIndexResult } from '@reviewlens/db';
import { githubSnapshot, type GitHubClient } from '@reviewlens/github';
import { withSpan, type IndexJobData, type Logger } from '@reviewlens/shared';

export interface IndexDeps {
  getClient(installationId: number): Promise<GitHubClient>;
  parseCache: ParseCache;
  upsertRepository(ctx: {
    installation: { githubId: number; account: string };
    repository: { githubId: number; fullName: string };
  }): Promise<number>;
  persistIndex(args: {
    repositoryId: number;
    sha: string;
    graph: RepoGraph;
    entries: readonly RepoFileEntry[];
  }): Promise<PersistIndexResult>;
  logger: Logger;
}

/**
 * Index a repository's default branch at one commit: list files, parse only blobs the
 * parse cache has not seen, link the graph, and store files/symbols/edges.
 */
export async function processIndexJob(job: IndexJobData, deps: IndexDeps) {
  const repo = { owner: job.owner, repo: job.repo };
  const log = deps.logger.child({ ...repo, sha: job.sha, deliveryId: job.deliveryId });
  return withSpan(
    'index.process',
    { 'github.repository': `${job.owner}/${job.repo}` },
    async () => {
      const client = await deps.getClient(job.installationId);
      const snapshot = githubSnapshot(client, repo, job.sha, {
        onTruncatedTree: () => log.warn('GitHub truncated the file tree; the index is partial'),
      });
      const entries = await snapshot.listFiles();
      const { graph, stats } = await buildRepoGraph(
        { listFiles: () => Promise.resolve(entries), readFile: (p) => snapshot.readFile(p) },
        deps.parseCache,
      );
      const repositoryId = await deps.upsertRepository({
        installation: { githubId: job.installationId, account: job.owner },
        repository: { githubId: job.repositoryId, fullName: `${job.owner}/${job.repo}` },
      });
      const persisted = await deps.persistIndex({ repositoryId, sha: job.sha, graph, entries });
      log.info({ index: stats, graph: graph.stats, persisted }, 'repository indexed');
      return { stats, persisted };
    },
  );
}
