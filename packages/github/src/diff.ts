/**
 * Minimal unified-diff parser for the `application/vnd.github.v3.diff` format.
 * Tracks old/new line numbers so callers can map hunks to file lines
 * (inline review comments use new-file line numbers on the RIGHT side).
 */

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  /** Line number in the old file; absent for added lines. */
  oldLine?: number;
  /** Line number in the new file; absent for deleted lines. */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Path before the change; null for added files. */
  oldPath: string | null;
  /** Path after the change; null for deleted files. */
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_HEADER = /^diff --git (\S+|"(?:[^"\\]|\\.)*") (\S+|"(?:[^"\\]|\\.)*")$/;

/** Strip git quoting ("a/sp ace") and the a/ or b/ prefix. */
function cleanPath(raw: string): string | null {
  let path = raw.trim();
  if (path === '/dev/null') return null;
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return path.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const match = DIFF_GIT_HEADER.exec(line);
      file = {
        oldPath: match?.[1] ? cleanPath(match[1]) : null,
        newPath: match?.[2] ? cleanPath(match[2]) : null,
        status: 'modified',
        binary: false,
        hunks: [],
      };
      hunk = undefined;
      oldRemaining = 0;
      newRemaining = 0;
      files.push(file);
      continue;
    }
    if (!file) continue;

    // Inside a hunk, trust the header counts rather than prefixes: a deleted line
    // whose content starts with "-- " would otherwise look like a "--- " file header.
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith('+')) {
        hunk.lines.push({ type: 'add', content: line.slice(1), newLine: newLine++ });
        newRemaining--;
        continue;
      }
      if (line.startsWith('-')) {
        hunk.lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++ });
        oldRemaining--;
        continue;
      }
      if (line.startsWith(' ') || line === '') {
        hunk.lines.push({
          type: 'context',
          content: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
        oldRemaining--;
        newRemaining--;
        continue;
      }
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: newLine,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = cleanPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = cleanPath(line.slice('rename to '.length));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
    } else if (line.startsWith('--- ')) {
      file.oldPath = cleanPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      file.newPath = cleanPath(line.slice(4));
    }
  }

  for (const f of files) {
    if (f.status === 'added') f.oldPath = null;
    if (f.status === 'deleted') f.newPath = null;
  }
  return files;
}

export interface LineLocation {
  path: string;
  line: number;
}

/** First added line in the diff, as a RIGHT-side location usable for an inline comment. */
export function firstAddedLine(files: FileDiff[]): LineLocation | undefined {
  for (const file of files) {
    if (file.binary || file.newPath === null) continue;
    for (const hunk of file.hunks) {
      const added = hunk.lines.find((l) => l.type === 'add');
      if (added?.newLine !== undefined) return { path: file.newPath, line: added.newLine };
    }
  }
  return undefined;
}
