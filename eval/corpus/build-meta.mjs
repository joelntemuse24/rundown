// Refreshes eval/corpus/<case>.meta.json and <case>.patch from the pinned pull requests.
// The meta files are the source of truth: this reads repo and number from each one and only
// overwrites the fields GitHub can supply. Run it when a case is added or a field changes.
//
//   node eval/corpus/build-meta.mjs           # refresh every case in place
//   node eval/corpus/build-meta.mjs <case>    # refresh one case
//
// Needs `gh` on PATH with a token that can read the repositories. Not part of the build or tests.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url).pathname;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const api = (path) => JSON.parse(gh(['api', path]));

const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => f.slice(0, -'.meta.json'.length))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

for (const name of cases) {
  const metaPath = join(dir, `${name}.meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!meta.repo || !Number.isInteger(meta.number)) {
    console.error(`  ${name}: meta has no repo/number, skipping`);
    continue;
  }
  const pr = api(`repos/${meta.repo}/pulls/${meta.number}`);
  const commits = api(`repos/${meta.repo}/pulls/${meta.number}/commits?per_page=100`);
  const patch = gh(['api', `repos/${meta.repo}/pulls/${meta.number}`, '-H', 'Accept: application/vnd.github.v3.diff']);
  const next = {
    ...meta,
    title: pr.title,
    body: pr.body ?? '',
    commits: commits.map((c) => String(c.commit.message).split('\n')[0]),
    repo: meta.repo,
    number: meta.number,
    base: pr.base.sha,
    head: pr.head.sha,
    merged_at: pr.merged_at,
    url: `https://github.com/${meta.repo}/pull/${meta.number}`,
  };
  writeFileSync(metaPath, JSON.stringify(next, null, 2) + '\n');
  writeFileSync(join(dir, `${name}.patch`), patch + '\n');
  console.log(`  ${name}\t${next.base.slice(0, 8)}\t${next.head.slice(0, 8)}\t${next.title}`);
}

// License fields are read from the repository at the pinned head, not guessed:
//   gh api "repos/<owner>/<repo>/contents/<license file>?ref=<head>"
console.log(`\n${cases.length} case(s) refreshed.`);
