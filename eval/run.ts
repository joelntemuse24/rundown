/**
 * `pnpm eval` — one model call per corpus case, no cache, scored with no model.
 *
 * It costs calls, so it is not part of `pnpm test`. The same scorer runs against the
 * fixture in test/eval.test.ts, which is what CI checks.
 *
 * `pnpm eval --dry <dir>` scores saved replies (one `<case>.json` per corpus case) with
 * no model calls, so a scorer change can be checked without spending budget.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { extractFacts } from '../src/facts.js';
import { parseModelJson } from '../src/generate.js';
import { complete } from '../src/model.js';
import { buildMessages, PROMPT_VERSION, repairMessages } from '../src/prompt.js';
import { caseFromDiff, failedScore, formatSummary, parseFirstReply, scoreReply, scoreSavedReply, summarise, type EvalCase, type RunScore } from './score.js';

interface Meta {
  title?: string;
  body?: string;
  commits?: string[];
  url?: string;
}

const args = process.argv.slice(2);
const dryIndex = args.indexOf('--dry');
const dryDir = dryIndex >= 0 ? resolve(args[dryIndex + 1] ?? '') : '';
const only = args.filter((a, i) => !a.startsWith('-') && i !== dryIndex + 1);
const corpusDir = new URL('./corpus/', import.meta.url).pathname;
const outDir = resolve(new URL('./out/', import.meta.url).pathname);

function cases(): Array<{ name: string; meta: Meta; diff: string }> {
  const names = readdirSync(corpusDir)
    .filter((f) => f.endsWith('.patch'))
    .map((f) => basename(f, '.patch'))
    .sort();
  return names
    .filter((n) => only.length === 0 || only.some((o) => n.includes(o)))
    .map((name) => {
      const metaPath = join(corpusDir, `${name}.meta.json`);
      const meta: Meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
      return { name, meta, diff: readFileSync(join(corpusDir, `${name}.patch`), 'utf8') };
    });
}

function prepared(name: string, diff: string) {
  const p = extractFacts({ diff });
  return { p, c: caseFromDiff(name, diff, p.facts) };
}

function scoreSaved(name: string, diff: string): RunScore {
  const { c } = prepared(name, diff);
  const tokens = { prompt: 0, completion: 0 };
  const file = join(dryDir, `${name}.json`);
  if (!existsSync(file)) return failedScore(name, tokens);
  return scoreSavedReply(c, readFileSync(file, 'utf8'), tokens);
}

async function scoreLive(name: string, meta: Meta, diff: string, cfg: ReturnType<typeof loadConfig>): Promise<RunScore> {
  const { p, c } = prepared(name, diff);
  const messages = buildMessages(p.facts, p.files, p.functionRanges, { title: meta.title, body: meta.body, commits: meta.commits });
  const first = await complete(cfg, messages);
  let tokens = { prompt: first.promptTokens, completion: first.completionTokens };
  const parsed = parseFirstReply(first.content);
  if (parsed.ok) return scoreReply(c, parsed.value, tokens, false);
  // The same single repair call generate.ts makes.
  const repaired = await complete(cfg, repairMessages(messages, first.content, ['response is not JSON; return a single JSON object only']));
  tokens = { prompt: tokens.prompt + repaired.promptTokens, completion: tokens.completion + repaired.completionTokens };
  try {
    return scoreReply(c, parseModelJson(repaired.content), tokens, true);
  } catch {
    return failedScore(name, tokens);
  }
}

async function main() {
  const cfg = loadConfig();
  if (!dryDir && !cfg.apiKey) {
    console.error('rundown eval: no model key. Set RUNDOWN_API_KEY (and RUNDOWN_BASE_URL / RUNDOWN_MODEL) first, or pass --dry <dir> with saved replies.');
    process.exit(1);
  }
  const list = cases();
  if (!list.length) {
    console.error('rundown eval: no corpus cases matched.');
    process.exit(1);
  }
  if (dryDir && !existsSync(dryDir)) {
    console.error(`rundown eval: ${dryDir} does not exist.`);
    process.exit(1);
  }
  const model = dryDir ? `dry:${basename(dryDir)}` : cfg.model;
  console.error(`rundown eval: ${list.length} cases as ${model}${dryDir ? ', no model calls' : `; this costs ${list.length} to ${list.length * 2} calls`}.`);

  const scores: RunScore[] = [];
  for (const { name, meta, diff } of list) {
    process.stderr.write(`  ${name} … `);
    try {
      const s = dryDir ? scoreSaved(name, diff) : await scoreLive(name, meta, diff, cfg);
      scores.push(s);
      process.stderr.write(`${s.evidenceInDiff}/${s.evidenceTotal} evidence\n`);
    } catch (err) {
      // A failing call is a result too, so a broken endpoint never looks like a clean run.
      scores.push(failedScore(name, { prompt: 0, completion: 0 }));
      process.stderr.write(`call failed: ${(err as Error).message}\n`);
    }
  }

  const summary = summarise(scores);
  const record = { model, at: new Date().toISOString(), prompt_version: PROMPT_VERSION, summary, scores };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${stamp}-${model.replace(/[^\w.-]+/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(formatSummary(summary, scores));
  console.error(`\nrundown eval: wrote ${file}`);
}

main().catch((err) => {
  console.error(`rundown eval: ${(err as Error).message}`);
  process.exit(1);
});
