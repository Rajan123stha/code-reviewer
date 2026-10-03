import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './app.js';
import {
  fetchCompareDiff,
  fetchFileAtRef,
  fetchTree,
  githubSnapshot,
  MAX_FILE_BYTES,
} from './pulls.js';

function client(handler: (route: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    const out = handler(route, params);
    if (out instanceof Error) throw out;
    return { data: out };
  });
  return { gh: { request } as unknown as GitHubClient, request };
}

const repo = { owner: 'octo', repo: 'shop' };

describe('fetchCompareDiff', () => {
  it('pins the diff to base...head commits', async () => {
    const { gh, request } = client(() => 'diff --git a/x b/x');
    expect(await fetchCompareDiff(gh, repo, 'b1', 'h1')).toBe('diff --git a/x b/x');
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      expect.objectContaining({ basehead: 'b1...h1', mediaType: { format: 'diff' } }),
    );
  });
});

describe('fetchFileAtRef', () => {
  it('returns raw text at the ref', async () => {
    const { gh, request } = client(() => 'export const a = 1;\n');
    expect(await fetchFileAtRef(gh, repo, 'src/a.ts', 'h1')).toBe('export const a = 1;\n');
    expect(request.mock.calls[0]![1]).toMatchObject({
      path: 'src/a.ts',
      ref: 'h1',
      mediaType: { format: 'raw' },
    });
  });

  it('returns null for missing files, directories and oversized files', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    expect(await fetchFileAtRef(client(() => notFound).gh, repo, 'x', 'h')).toBeNull();
    expect(await fetchFileAtRef(client(() => [{ name: 'a' }]).gh, repo, 'dir', 'h')).toBeNull();
    expect(
      await fetchFileAtRef(client(() => 'x'.repeat(MAX_FILE_BYTES + 1)).gh, repo, 'big', 'h'),
    ).toBeNull();
  });

  it('rethrows other errors', async () => {
    const err = Object.assign(new Error('Bad Gateway'), { status: 502 });
    await expect(fetchFileAtRef(client(() => err).gh, repo, 'x', 'h')).rejects.toBe(err);
  });
});

describe('fetchTree', () => {
  it('lists regular files with blob ids, skipping symlinks, dirs and submodules', async () => {
    const { gh, request } = client(() => ({
      truncated: false,
      tree: [
        { path: 'src', type: 'tree', mode: '040000', sha: 't1' },
        { path: 'src/a.ts', type: 'blob', mode: '100644', sha: 'b1', size: 10 },
        { path: 'link', type: 'blob', mode: '120000', sha: 'b2', size: 4 },
        { path: 'vendor/lib', type: 'commit', mode: '160000', sha: 'c1' },
      ],
    }));
    expect(await fetchTree(gh, repo, 'h1')).toEqual({
      entries: [{ path: 'src/a.ts', blobSha: 'b1', size: 10 }],
      truncated: false,
    });
    expect(request.mock.calls[0]![1]).toMatchObject({ tree_sha: 'h1', recursive: '1' });
  });
});

describe('githubSnapshot', () => {
  it('fetches each path once', async () => {
    const { gh, request } = client(() => 'content');
    const snap = githubSnapshot(gh, repo, 'h1');
    await Promise.all([snap.readFile('a.ts'), snap.readFile('a.ts'), snap.readFile('b.ts')]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(snap.sha).toBe('h1');
  });
});
