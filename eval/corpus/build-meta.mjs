// Refreshes eval/corpus/<case>.meta.json and <case>.patch from the pinned pull requests.
// The meta files are the source of truth: this reads repo and number from each one and only
// overwrites the fields GitHub can supply. Run it when a case is added or a field changes.
//
//   node eval/corpus/build-meta.mjs --check   # report what a refresh would change; write nothing
//   node eval/corpus/build-meta.mjs           # refresh every case in place
//   node eval/corpus/build-meta.mjs <case>    # refresh one case
//
// The license comes from GitHub's license API at the pinned head. When GitHub cannot name one
// SPDX id (dual-licensed repositories report NOASSERTION), the meta keeps its hand-checked value.
//
// Needs `gh` on PATH with a token that can read the repositories. Not part of the build or tests.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url).pathname;
const check = process.argv.includes('--check');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const api = (path) => JSON.parse(gh(['api', path]));

const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => f.slice(0, -'.meta.json'.length))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

let changed = 0;
const manual = [];
for (const name of cases) {
  const metaPath = join(dir, `${name}.meta.json`);
  const patchPath = join(dir, `${name}.patch`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!meta.repo || !Number.isInteger(meta.number)) {
    console.error(`  ${name}: meta has no repo/number, skipping`);
    continue;
  }
  const pr = api(`repos/${meta.repo}/pulls/${meta.number}`);
  const commits = api(`repos/${meta.repo}/pulls/${meta.number}/commits?per_page=100`);
  const patch = gh(['api', `repos/${meta.repo}/pulls/${meta.number}`, '-H', 'Accept: application/vnd.github.v3.diff']) + '\n';
  const lic = api(`repos/${meta.repo}/license?ref=${pr.head.sha}`);
  const spdx = lic.license?.spdx_id;
  const named = spdx && spdx !== 'NOASSERTION' && spdx !== 'OTHER';
  if (!named) manual.push(`${name} (${meta.license ?? 'no license recorded'})`);
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
    ...(named ? { license: spdx } : {}),
  };

  const diffs = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(meta[k]));
  const patchChanged = !existsSync(patchPath) || readFileSync(patchPath, 'utf8') !== patch;
  if (patchChanged) diffs.push('patch');
  if (diffs.length) changed++;
  console.log(`  ${name}\t${diffs.length ? `changes: ${diffs.join(', ')}` : 'up to date'}`);
  if (check) continue;
  writeFileSync(metaPath, JSON.stringify(next, null, 2) + '\n');
  if (patchChanged) writeFileSync(patchPath, patch);
}

if (manual.length) console.log(`\nGitHub names no single license for: ${manual.join(', ')}. Check those by hand.`);
console.log(`\n${cases.length} case(s), ${changed} ${check ? 'would change' : 'changed'}.`);
if (check && changed) process.exit(1);
