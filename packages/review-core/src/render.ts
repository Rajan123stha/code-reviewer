import type { FileDiff } from '@reviewlens/github';

/**
 * Render one file's diff for the prompt. Lines the model may comment on (added and context
 * lines on the new side) carry an `R<line>` label with their new-file line number, so the
 * model never has to count lines itself. Deleted lines have no label.
 *
 *   <diff path="src/a.ts" status="modified">
 *   @@ -10,3 +10,4 @@
 *     R10   const x = 1;
 *           -  return x;
 *     R11 +  return x + 1;
 *   </diff>
 */
export function renderFileDiff(file: FileDiff): string {
  const path = file.newPath ?? file.oldPath ?? '';
  const out = [`<diff path="${escapeAttr(path)}" status="${file.status}">`];
  for (const hunk of file.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const label = line.newLine !== undefined && line.type !== 'del' ? `R${line.newLine}` : '';
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(`${label.padStart(6)} ${marker}${line.content}`);
    }
  }
  out.push('</diff>');
  return out.join('\n');
}

/** Render a whole file with `<line>|` prefixes, for reference context (not commentable). */
export function renderFile(path: string, content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const width = String(lines.length).length;
  const body = lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join('\n');
  return `<file path="${escapeAttr(path)}" ref="head">\n${body}\n</file>`;
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
