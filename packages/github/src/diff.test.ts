import { describe, expect, it } from 'vitest';
import { firstAddedLine, parseUnifiedDiff } from './diff.js';

const MODIFIED = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,4 +1,5 @@
 export function add(a: number, b: number) {
-  return a - b;
+  // fixed operator
+  return a + b;
 }

@@ -10,2 +11,2 @@ export function mul(a: number, b: number) {
-  return a;
+  return a * b;
 }
`;

describe('parseUnifiedDiff', () => {
  it('tracks old and new line numbers across multiple hunks', () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file).toMatchObject({
      oldPath: 'src/math.ts',
      newPath: 'src/math.ts',
      status: 'modified',
    });
    expect(file!.hunks).toHaveLength(2);

    const first = file!.hunks[0]!;
    expect(first.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ]);

    const second = file!.hunks[1]!;
    expect(second.lines.find((l) => l.type === 'add')).toMatchObject({
      content: '  return a * b;',
      newLine: 11,
    });
  });

  it('handles added, deleted and renamed files', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/old.ts b/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const z = 3;
diff --git a/a.ts b/b.ts
similarity index 100%
rename from a.ts
rename to b.ts
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.status, f.oldPath, f.newPath])).toEqual([
      ['added', null, 'new.ts'],
      ['deleted', 'old.ts', null],
      ['renamed', 'a.ts', 'b.ts'],
    ]);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
    expect(files[1]!.hunks[0]!.oldLines).toBe(1);
  });

  it('marks binary files and skips "no newline" markers', () => {
    const diff = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/x.ts b/x.ts
index 7777777..8888888 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const [png, ts] = parseUnifiedDiff(diff);
    expect(png!.binary).toBe(true);
    expect(ts!.hunks[0]!.lines.map((l) => l.type)).toEqual(['del', 'add']);
  });

  it('does not mistake a deleted "-- " line for a file header', () => {
    const diff = `diff --git a/q.sql b/q.sql
index 1..2 100644
--- a/q.sql
+++ b/q.sql
@@ -1,2 +1,1 @@
--- a SQL comment
 select 1;
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file!.oldPath).toBe('q.sql');
    expect(file!.hunks[0]!.lines[0]).toMatchObject({ type: 'del', content: '-- a SQL comment' });
  });

  it('unquotes paths with special characters', () => {
    const diff = `diff --git "a/my file.ts" "b/my file.ts"
index 1..2 100644
--- "a/my file.ts"
+++ "b/my file.ts"
@@ -0,0 +1 @@
+x
`;
    expect(parseUnifiedDiff(diff)[0]!.newPath).toBe('my file.ts');
  });

  it('accepts CRLF line endings', () => {
    const [file] = parseUnifiedDiff(MODIFIED.replace(/\n/g, '\r\n'));
    expect(file!.hunks[0]!.lines).toHaveLength(6);
  });
});

describe('firstAddedLine', () => {
  it('returns the first added line, skipping deleted and binary files', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
${MODIFIED}`;
    expect(firstAddedLine(parseUnifiedDiff(diff))).toEqual({ path: 'src/math.ts', line: 2 });
  });

  it('returns undefined when nothing was added', () => {
    expect(firstAddedLine(parseUnifiedDiff(''))).toBeUndefined();
  });
});
