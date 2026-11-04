import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff.js';
import { citationInDiff } from '../src/schema.js';

const patch = readFileSync(new URL('../fixtures/sample.patch', import.meta.url), 'utf8');
const files = parseDiff(patch);

const deleted = [
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-import x from "y";',
  '-const a = 1;',
  '-export default a;',
  '',
].join('\n');

describe('citationInDiff', () => {
  it('accepts a line inside a hunk on the new side', () => {
    expect(citationInDiff(files, 'src/middleware/loginLimiter.js:10')).toBe(true);
    expect(citationInDiff(files, 'package.json:11')).toBe(true);
  });

  it('rejects a line outside every hunk, an unknown path, and a non-citation', () => {
    expect(citationInDiff(files, 'src/middleware/loginLimiter.js:900')).toBe(false);
    expect(citationInDiff(files, 'src/nowhere.js:10')).toBe(false);
    expect(citationInDiff(files, 'see the middleware')).toBe(false);
    expect(citationInDiff(files, '')).toBe(false);
  });

  it('reads the old side of a deleted file', () => {
    const gone = parseDiff(deleted);
    expect(citationInDiff(gone, 'gone.js:2')).toBe(true);
    expect(citationInDiff(gone, 'gone.js:9')).toBe(false);
  });

  it('agrees with the committed replay: every citation in the sample is inside the diff', () => {
    const replay: any = JSON.parse(readFileSync(new URL('../fixtures/sample.replay.json', import.meta.url), 'utf8'));
    const evidence = [
      ...replay.dependencies.map((d: any) => d.evidence),
      ...replay.logic.map((l: any) => l.evidence),
      ...replay.tests.map((t: any) => t.evidence),
      ...replay.open_questions.map((q: any) => q.evidence),
      ...replay.functions.map((f: any) => f.evidence),
    ].filter(Boolean);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.filter((ev: string) => !citationInDiff(files, ev))).toEqual([]);
  });
});
