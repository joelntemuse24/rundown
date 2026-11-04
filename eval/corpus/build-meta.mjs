// Builds eval/corpus/*.meta.json from the pinned PR metadata downloaded alongside the patches.
// Not part of the run; kept so the corpus can be rebuilt or extended with the same fields.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: node build-meta.mjs <dir with meta-*.json and commits-*.json>');
  process.exit(1);
}

const CASES = JSON.parse(readFileSync(join(src, 'cases.json'), 'utf8'));
const out = process.argv[3] ?? new URL('.', import.meta.url).pathname;

for (const { slug, repo, n } of CASES) {
  const safe = repo.replace('/', '_');
  const meta = JSON.parse(readFileSync(join(src, `meta-${safe}-${n}.json`), 'utf8'));
  const commits = JSON.parse(readFileSync(join(src, `commits-${safe}-${n}.json`), 'utf8'));
  const record = {
    title: meta.title,
    body: meta.body ?? '',
    commits,
    repo,
    number: n,
    base: meta.base,
    head: meta.head,
    merged_at: meta.merged,
    url: `https://github.com/${repo}/pull/${n}`,
  };
  writeFileSync(join(out, `${slug}.meta.json`), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(join(out, `${slug}.patch`), readFileSync(join(src, `patch-${safe}-${n}.patch`)));
  console.log(`${slug}\t${meta.base.slice(0, 8)}\t${meta.head.slice(0, 8)}\t${meta.title}`);
}
