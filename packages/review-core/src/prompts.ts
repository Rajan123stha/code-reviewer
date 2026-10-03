import { readFile } from 'node:fs/promises';
import { sha256 } from '@reviewlens/shared';

/** Prompt files live in packages/review-core/prompts/<name>/<version>/; one directory per version. */
const PROMPTS_ROOT = new URL('../prompts/', import.meta.url);

export interface LoadedPrompt {
  /** Declared version, e.g. "review/v1". */
  version: string;
  /** Hash of the prompt files' contents; changes if a file is edited without a version bump. */
  contentHash: string;
  system: string;
  user: string;
}

const cache = new Map<string, Promise<LoadedPrompt>>();

export function loadPrompt(version: string): Promise<LoadedPrompt> {
  if (!/^[a-z-]+\/v\d+$/.test(version)) throw new Error(`invalid prompt version: ${version}`);
  let loaded = cache.get(version);
  if (!loaded) {
    loaded = (async () => {
      const dir = new URL(`${version}/`, PROMPTS_ROOT);
      const [system, user] = await Promise.all([
        readFile(new URL('system.md', dir), 'utf8'),
        readFile(new URL('user.md', dir), 'utf8'),
      ]);
      const normalized = { system: normalize(system), user: normalize(user) };
      return {
        version,
        contentHash: sha256(`${normalized.system}\0${normalized.user}`).slice(0, 12),
        ...normalized,
      };
    })();
    cache.set(version, loaded);
  }
  return loaded;
}

/** Line endings normalized so a Windows checkout produces the same prompt and hash. */
function normalize(text: string) {
  return text.replace(/\r\n/g, '\n').trim();
}

/** Fill `{{name}}` placeholders. Unknown placeholders and unused variables are errors. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const used = new Set<string>();
  const out = template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`template variable not provided: ${name}`);
    used.add(name);
    return vars[name]!;
  });
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`template variables not used: ${unused.join(', ')}`);
  return out;
}
