import type { GitHubClient } from './app.js';

export interface PullRequestRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface InlineComment {
  path: string;
  /** Line number in the new file (RIGHT side of the diff). */
  line: number;
  body: string;
}

export interface ReviewToPost {
  /** Commit the comments are anchored to; normally the PR head SHA the review ran on. */
  commitId: string;
  body: string;
  comments: InlineComment[];
}

export interface PullRequestDetails {
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  headSha: string;
  baseSha: string;
}

export async function fetchPullRequest(
  client: GitHubClient,
  pr: PullRequestRef,
): Promise<PullRequestDetails> {
  const { data } = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
  });
  return {
    title: data.title,
    body: data.body,
    state: data.state,
    draft: data.draft ?? false,
    headSha: data.head.sha,
    baseSha: data.base.sha,
  };
}

/**
 * Unified diff of base...head (merge-base comparison, the same diff a PR shows), pinned to
 * the given commits. Unlike the PR diff endpoint, this cannot drift if the PR gets new
 * pushes while a review job is queued.
 */
export async function fetchCompareDiff(
  client: GitHubClient,
  repo: { owner: string; repo: string },
  baseSha: string,
  headSha: string,
): Promise<string> {
  const response = await client.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${baseSha}...${headSha}`,
    mediaType: { format: 'diff' },
  });
  return response.data as unknown as string;
}

/** Files above this size are not read as context (generated code, fixtures, data). */
export const MAX_FILE_BYTES = 1_000_000;

/** Text contents of a file at a commit; null if missing, a directory, or too large. */
export async function fetchFileAtRef(
  client: GitHubClient,
  repo: { owner: string; repo: string },
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const response = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
      mediaType: { format: 'raw' },
    });
    const data: unknown = response.data;
    if (typeof data !== 'string' || data.length > MAX_FILE_BYTES) return null;
    return data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export interface TreeEntry {
  path: string;
  /** Git blob id of the file contents. */
  blobSha: string;
  size: number | undefined;
}

/**
 * Every regular file at a commit, from one recursive tree request. Symlinks and
 * submodules are skipped. GitHub truncates very large trees (over 100k entries or 7 MB);
 * `truncated` reports that so callers can log incomplete indexes.
 */
export async function fetchTree(
  client: GitHubClient,
  repo: { owner: string; repo: string },
  sha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const { data } = await client.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    owner: repo.owner,
    repo: repo.repo,
    tree_sha: sha,
    recursive: '1',
  });
  const entries = data.tree
    .filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path && e.sha)
    .map((e) => ({ path: e.path, blobSha: e.sha, size: e.size }));
  return { entries, truncated: data.truncated };
}

/** Repository snapshot backed by the tree and contents APIs, with per-path memoization. */
export function githubSnapshot(
  client: GitHubClient,
  repo: { owner: string; repo: string },
  sha: string,
  options: { onTruncatedTree?: () => void } = {},
) {
  const reads = new Map<string, Promise<string | null>>();
  let tree: Promise<TreeEntry[]> | undefined;
  return {
    sha,
    listFiles(): Promise<TreeEntry[]> {
      tree ??= fetchTree(client, repo, sha).then(({ entries, truncated }) => {
        if (truncated) options.onTruncatedTree?.();
        return entries;
      });
      return tree;
    },
    readFile(path: string): Promise<string | null> {
      let read = reads.get(path);
      if (!read) {
        read = fetchFileAtRef(client, repo, path, sha);
        reads.set(path, read);
      }
      return read;
    },
  };
}

/** Fetch the PR as a unified diff (GitHub caps this at 3000 files / 20k lines). */
export async function fetchPullRequestDiff(client: GitHubClient, pr: PullRequestRef) {
  const response = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    mediaType: { format: 'diff' },
  });
  // With the diff media type GitHub returns text, but Octokit types the JSON shape.
  return response.data as unknown as string;
}

/** Post one review containing all inline comments, as a non-blocking COMMENT review. */
export async function createReview(
  client: GitHubClient,
  pr: PullRequestRef,
  review: ReviewToPost,
): Promise<{ reviewId: number; url: string }> {
  const response = await client.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    commit_id: review.commitId,
    event: 'COMMENT',
    body: review.body,
    comments: review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT' as const,
      body: c.body,
    })),
  });
  // Octokit types int64 ids as number | bigint; GitHub review ids fit safely in a JS number.
  return { reviewId: Number(response.data.id), url: response.data.html_url };
}
