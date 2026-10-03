import { readFileSync } from 'node:fs';
import { App } from '@octokit/app';
import type { Octokit } from '@octokit/core';

/** The subset of Octokit the pipeline uses. Narrow on purpose, so tests can fake it. */
export type GitHubClient = Pick<Octokit, 'request'>;

export interface GitHubAppConfig {
  appId: string | number;
  privateKey: string;
}

export interface GitHubAppClients {
  /** Octokit authenticated as one installation (token minted and cached by @octokit/app). */
  forInstallation(installationId: number): Promise<GitHubClient>;
}

export function createGitHubApp(config: GitHubAppConfig): GitHubAppClients {
  const app = new App({ appId: config.appId, privateKey: config.privateKey });
  return {
    forInstallation: (installationId) => app.getInstallationOctokit(installationId),
  };
}

/**
 * Resolve the App private key from either an inline value (newlines may be escaped
 * as "\n", which is how most secret stores and .env files carry PEM keys) or a file path.
 */
export function loadPrivateKey(options: {
  inline?: string | undefined;
  path?: string | undefined;
}) {
  if (options.inline) return options.inline.replace(/\\n/g, '\n');
  if (options.path) return readFileSync(options.path, 'utf8');
  throw new Error('Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH');
}
