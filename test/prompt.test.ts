import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFacts } from '../src/facts.js';
import { buildMessages, DIFF_BUDGET, truncateDiff } from '../src/prompt.js';

const patch = readFileSync(new URL('../fixtures/sample.patch', import.meta.url), 'utf8');
const r = extractFacts({ diff: patch });

describe('truncateDiff reports what the model did not see', () => {
  it('names every file dropped over budget', () => {
    const out = truncateDiff(r.files, r.functionRanges, 1500);
    expect(out.omitted.length).toBeGreaterThan(0);
    expect(out.omitted).not.toContain('package.json');
    for (const p of out.omitted) expect(out.text).not.toContain(`diff --git a/${p} b/${p}\ndiff`);
    expect(out.text).toContain(`omitted files: ${out.omitted.join(', ')}`);
    expect(out.summarised).toEqual([]);
  });

  it('returns the whole diff with nothing omitted when the budget is ample', () => {
    const out = truncateDiff(r.files, r.functionRanges, DIFF_BUDGET);
    expect(out.omitted).toEqual([]);
    expect(out.summarised).toEqual([]);
    expect(out.text).toBe(truncateDiff(r.files, r.functionRanges, DIFF_BUDGET).text);
    for (const f of r.files) expect(out.text).toContain(`diff --git a/${f.oldPath} b/${f.path}`);
  });

  it('lists a large new file it showed only as signatures and the two ends', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `+  const v${i} = ${i};`);
    const big = [
      'diff --git a/src/big.js b/src/big.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/big.js',
      '@@ -0,0 +1,500 @@',
      '+export function first() {',
      ...lines,
      '+}',
      '',
    ].join('\n');
    const bigFacts = extractFacts({ diff: big });
    const out = truncateDiff(bigFacts.files, bigFacts.functionRanges, DIFF_BUDGET);
    expect(out.summarised).toEqual(['src/big.js']);
    expect(out.omitted).toEqual([]);
    expect(out.text).toContain('shown as signatures plus first and last 40 lines');
  });

  it('puts the same accounting into the messages the model sees', () => {
    const msgs = buildMessages(r.facts, r.files, r.functionRanges, { title: 'T', body: 'B', commits: ['c'] });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toContain('Unified diff:\ndiff --git a/package.json b/package.json');
  });
});
