import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff.js';
import { citationInDiff, outsideCitations, presentReplay } from '../src/schema.js';

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
    expect(outsideCitations(presentReplay(replay), files)).toEqual([]);
  });
});

describe('outsideCitations', () => {
  const replay: any = JSON.parse(readFileSync(new URL('../fixtures/sample.replay.json', import.meta.url), 'utf8'));

  it('labels each citation with its section and the path:line', () => {
    const doc = {
      ...replay,
      tests: [{ file: 'test/loginLimiter.test.js', locks: 'l', does_not_cover: 'd', evidence: 'test/x.test.js:999' }],
      functions: [{ path: 'src/middleware/loginLimiter.js', name: 'countAttempt', note: 'n', evidence: 'src/middleware/loginLimiter.js:900' }],
    };
    const out = outsideCitations(presentReplay(doc), files);
    expect(out.map((x) => x.label)).toEqual(['tests: test/x.test.js:999', 'functions: src/middleware/loginLimiter.js:900']);
    expect(out.map((x) => x.section)).toEqual(['tests', 'functions']);
  });

  it('counts citations the current depth hides, because the eval counts them too', () => {
    // functions render only at deep; the count must not shrink with the depth.
    const doc = { ...replay, functions: [{ path: 'x.js', name: 'f', note: 'n', evidence: 'x.js:5' }] };
    expect(outsideCitations(presentReplay(doc), files)).toHaveLength(1);
  });

  it('ignores an empty evidence string and keeps a non-citation as outside', () => {
    const doc = { ...replay, open_questions: [{ text: 'q', evidence: '' }, { text: 'q2', evidence: 'see the docs' }] };
    const out = outsideCitations(presentReplay(doc), files);
    expect(out.map((x) => x.evidence)).toEqual(['see the docs']);
  });
});
