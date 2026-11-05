import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../eval/corpus/', import.meta.url);
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.patch'))
  .map((f) => f.slice(0, -'.patch'.length))
  .sort();
const readme = existsSync(new URL('README.md', dir)) ? readFileSync(new URL('README.md', dir), 'utf8') : '';

describe('eval corpus', () => {
  it('has a patch and a meta file for every case', () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const n of names) {
      const meta = JSON.parse(readFileSync(new URL(`${n}.meta.json`, dir), 'utf8'));
      expect(meta.repo, n).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(Number.isInteger(meta.number), n).toBe(true);
      expect(meta.base, n).toMatch(/^[0-9a-f]{40}$/);
      expect(meta.head, n).toMatch(/^[0-9a-f]{40}$/);
      expect(meta.url, n).toBe(`https://github.com/${meta.repo}/pull/${meta.number}`);
      expect(meta.license, n).toBeTruthy();
    }
  });

  it('names each case, repository, PR, both shas, and license in the corpus README', () => {
    expect(readme, 'eval/corpus/README.md is missing').not.toBe('');
    for (const n of names) {
      const meta = JSON.parse(readFileSync(new URL(`${n}.meta.json`, dir), 'utf8'));
      expect(readme, n).toContain(n);
      expect(readme, n).toContain(meta.url);
      expect(readme, n).toContain(meta.base.slice(0, 7));
      expect(readme, n).toContain(meta.head.slice(0, 7));
      expect(readme, n).toContain(meta.license);
    }
  });

  it('says the patches are upstream code reproduced unmodified', () => {
    expect(readme).toMatch(/reproduced unmodified/i);
  });

  it('only carries licenses that allow redistribution', () => {
    const allowed = /^(MIT|Apache-2\.0|BSD-3-Clause|MIT OR Unlicense|MIT OR Apache-2\.0)$/;
    for (const n of names) {
      const meta = JSON.parse(readFileSync(new URL(`${n}.meta.json`, dir), 'utf8'));
      expect(meta.license, n).toMatch(allowed);
    }
  });
});
