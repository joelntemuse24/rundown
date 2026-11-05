import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('the published package', () => {
  it('lists exactly the files runtime code reads, so an install can start', () => {
    // bin/rundown.js loads dist/cli.js; export.ts reads web/dist through packageRoot;
    // --fixture reads fixtures/; README documents the configs in adapters/.
    for (const dir of ['bin', 'dist', 'web/dist', 'fixtures', 'adapters', 'README.md']) expect(pkg.files, dir).toContain(dir);
  });

  it('does not ship the eval corpus, the tests, or the TypeScript sources', () => {
    const listed = (p: string) => pkg.files.some((f: string) => f === p || f === `${p}/` || p.startsWith(`${f}/`));
    for (const p of ['eval', 'test', 'src', 'docs', 'eval/corpus', 'test/server.test.ts']) expect(listed(p), p).toBe(false);
  });

  it('builds before packing, because dist and web/dist are gitignored', () => {
    expect(pkg.scripts.prepack).toBe('npm run build');
  });

  it('builds with npm run, so packing and publishing do not need pnpm installed', () => {
    for (const s of ['build', 'prepack']) expect(pkg.scripts[s], s).not.toMatch(/\bpnpm\b/);
  });

  it('keeps the built entry point and the viewer in the tarball', () => {
    expect(pkg.bin.rundown).toBe('./bin/rundown.js');
    expect(pkg.main).toBeUndefined();
    // bin falls back to tsx only in an unbuilt checkout; tsx is a dev dependency and must not ship.
    expect(pkg.dependencies.tsx).toBeUndefined();
  });
});
