import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, type Config } from './config.js';
import type { DiffFile } from './diff.js';
import { extractFacts, sha256, type Facts, type FunctionRange } from './facts.js';
import { fetchPull, parsePrUrl } from './github.js';
import { complete, type ChatMessage } from './model.js';
import { buildMessages, repairMessages, type PromptContext } from './prompt.js';
import { groundReplay, SCHEMA_VERSION, validateReplay, type Replay } from './schema.js';

export type Status = 'pending' | 'ready' | 'failed';

export interface Source {
  kind: 'pr' | 'diff' | 'local' | 'fixture';
  label: string;
  pr_url?: string;
  root?: string;
}

export interface StoredReplay {
  schema_version: number;
  id: string;
  key: string;
  status: Status;
  model: string;
  created_at: string;
  updated_at: string;
  source: Source;
  context: PromptContext;
  facts: Facts;
  diff: string;
  replay: Replay | null;
  error: string | null;
}

export interface Prepared {
  source: Source;
  context: PromptContext;
  facts: Facts;
  canonicalDiff: string;
  files: DiffFile[];
  ranges: Map<string, FunctionRange[]>;
}

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- inputs ----------

export function prepareDiff(diff: string, opts: { base?: string; head?: string; transcript?: string[]; source?: Source; context?: PromptContext } = {}): Prepared {
  if (!diff.trim()) throw new Error('The diff is empty.');
  const r = extractFacts({ diff, base: opts.base, head: opts.head, transcript: opts.transcript });
  if (r.facts.files.length === 0) throw new Error('No files found in the diff. Is it a unified diff?');
  return {
    source: opts.source ?? { kind: 'diff', label: 'pasted diff' },
    context: opts.context ?? {},
    facts: r.facts,
    canonicalDiff: r.canonicalDiff,
    files: r.files,
    ranges: r.functionRanges,
  };
}

export async function preparePr(url: string, token?: string): Promise<Prepared> {
  const ref = parsePrUrl(url);
  if (!ref) throw new Error('That is not a GitHub pull request URL (https://github.com/owner/repo/pull/123).');
  const pr = await fetchPull(ref, token);
  return prepareDiff(pr.diff, {
    base: pr.base,
    head: pr.head,
    source: { kind: 'pr', label: `${pr.owner}/${pr.repo}#${pr.number}`, pr_url: pr.url },
    context: { title: pr.title, body: pr.body, commits: pr.commits },
  });
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Working tree (including untracked files) against the merge base with `base`. */
export function prepareLocal(repo: string, base = 'main', transcript?: string[]): Prepared {
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  let diff = git(root, ['diff', '--no-color', '--no-ext-diff', mergeBase]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of untracked) {
    try {
      git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', f]);
    } catch (err: any) {
      // `git diff --no-index` exits 1 when files differ; the patch is on stdout.
      if (typeof err.stdout === 'string') diff += err.stdout;
    }
  }
  const commits = git(root, ['log', '--format=%s', `${mergeBase}..HEAD`]).split('\n').filter(Boolean);
  return prepareDiff(diff, {
    base: mergeBase,
    head,
    transcript,
    source: { kind: 'local', label: `${root.split('/').pop()} vs ${base}`, root },
    context: { commits },
  });
}

// ---------- store ----------

const store = () => {
  const d = cacheDir();
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
};

export function readReplay(id: string): StoredReplay | null {
  if (!/^[0-9a-f]{12}$/.test(id)) return null;
  const p = join(store(), `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeReplay(doc: StoredReplay) {
  const p = join(store(), `${doc.id}.json`);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc));
  renameSync(tmp, p);
}

/** First 12 hex of the key; on a prefix collision with a different diff, re-hash with a salt. */
export function idFor(key: string): string {
  for (let salt = 0; ; salt++) {
    const id = (salt === 0 ? key : sha256(`${key}:${salt}`)).slice(0, 12);
    const existing = readReplay(id);
    if (!existing || existing.key === key) return id;
  }
}

export function cacheKey(diffHash: string, model: string): string {
  return sha256(`${diffHash}:${SCHEMA_VERSION}:${model}`);
}

export function listReplays(): Array<{ id: string; title: string; label: string; status: Status; created_at: string }> {
  const d = store();
  const out = [];
  for (const f of readdirSync(d)) {
    if (!/^[0-9a-f]{12}\.json$/.test(f)) continue;
    const doc = readReplay(f.slice(0, 12));
    if (!doc) continue;
    out.push({ id: doc.id, title: doc.replay?.intent.text || doc.context.title || doc.source.label, label: doc.source.label, status: doc.status, created_at: doc.created_at });
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function appendLog(diffHash: string, entry: Record<string, unknown>) {
  const p = join(store(), 'logs', `${diffHash}.json`);
  let log: any[] = [];
  try {
    log = JSON.parse(readFileSync(p, 'utf8'));
  } catch {}
  log.push({ at: new Date().toISOString(), ...entry });
  writeFileSync(p, JSON.stringify(log, null, 2));
}

export function appendHookLog(line: string) {
  writeFileSync(join(store(), 'logs', 'hook.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
}

// ---------- generation ----------

const inflight = new Map<string, Promise<StoredReplay>>();

function newDoc(p: Prepared, id: string, key: string, model: string): StoredReplay {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    id,
    key,
    status: 'pending',
    model,
    created_at: now,
    updated_at: now,
    source: p.source,
    context: p.context,
    facts: p.facts,
    diff: p.canonicalDiff,
    replay: null,
    error: null,
  };
}

export function parseModelJson(content: string): unknown {
  // Tolerate a single wrapping code fence; anything else that is not JSON is prose and fails.
  const t = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  return JSON.parse(t);
}

async function runModel(p: Prepared, doc: StoredReplay, cfg: Pick<Config, 'baseURL' | 'apiKey' | 'model'>, quiet = false): Promise<StoredReplay> {
  const vctx = { facts: p.facts, files: p.files, hasPrBody: !!p.context.body?.trim(), hasCommits: !!p.context.commits?.length };
  const messages = buildMessages(p.facts, p.files, p.ranges, p.context);
  const attempt = async (msgs: ChatMessage[], label: string) => {
    const c = await complete(cfg, msgs);
    let errors: string[];
    let dropped: string[] = [];
    let replay: Replay | null = null;
    try {
      const v = groundReplay(parseModelJson(c.content), vctx);
      if (v.ok) {
        replay = v.replay;
        dropped = v.dropped;
      }
      errors = v.ok ? [] : v.errors;
    } catch {
      errors = ['(root): response is not JSON; return a single JSON object only'];
    }
    appendLog(p.facts.diff_hash, { id: doc.id, attempt: label, model: c.model, prompt_tokens: c.promptTokens, completion_tokens: c.completionTokens, ok: !!replay, errors, dropped });
    return { replay, errors, content: c.content };
  };

  try {
    let r = await attempt(messages, 'first');
    if (!r.replay) r = await attempt(repairMessages(messages, r.content, r.errors), 'repair');
    if (!r.replay) throw new Error(`The model's replay failed validation twice: ${r.errors.slice(0, 5).join('; ')}`);
    return { ...doc, status: 'ready', replay: r.replay, error: null, updated_at: new Date().toISOString() };
  } catch (err) {
    const message = (err as Error).message;
    appendLog(p.facts.diff_hash, { id: doc.id, error: message });
    if (!quiet) console.error(`rundown: generation failed for ${doc.id}: ${message}`);
    return { ...doc, status: 'failed', replay: null, error: message, updated_at: new Date().toISOString() };
  }
}

/**
 * Returns the cached replay or starts one. With `wait: false` the pending document comes back
 * immediately and the page polls /r/:id.json.
 */
export async function generate(p: Prepared, cfg: Pick<Config, 'baseURL' | 'apiKey' | 'model'>, opts: { wait: boolean; beforeModel?: () => void; quiet?: boolean }): Promise<StoredReplay> {
  const key = cacheKey(p.facts.diff_hash, cfg.model);
  const id = idFor(key);
  const existing = readReplay(id);
  if (existing?.status === 'ready') return existing;
  const running = inflight.get(id);
  if (running) return opts.wait ? running : existing!;

  opts.beforeModel?.();
  const doc = newDoc(p, id, key, cfg.model);
  writeReplay(doc);
  const run = runModel(p, doc, cfg, opts.quiet)
    .then((done) => {
      writeReplay(done);
      return done;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, run);
  return opts.wait ? run : doc;
}

export function waitFor(id: string): Promise<StoredReplay> | null {
  return inflight.get(id) ?? null;
}

/** The fixture renders with no key and no model call. */
export function generateFixture(patchPath: string): StoredReplay {
  const diff = readFileSync(patchPath, 'utf8');
  const p = prepareDiff(diff, { source: { kind: 'fixture', label: patchPath.split('/').pop()! } });
  const replayPath = patchPath.replace(/\.patch$/, '.replay.json');
  if (!existsSync(replayPath)) throw new Error(`No committed replay next to the fixture (${replayPath}).`);
  const v = validateReplay(JSON.parse(readFileSync(replayPath, 'utf8')), { facts: p.facts, files: p.files, hasPrBody: false, hasCommits: false });
  if (!v.ok) throw new Error(`Fixture replay failed validation: ${v.errors.join('; ')}`);
  const key = cacheKey(p.facts.diff_hash, 'fixture');
  const doc: StoredReplay = { ...newDoc(p, idFor(key), key, 'fixture'), status: 'ready', replay: v.replay };
  writeReplay(doc);
  return doc;
}

export function summaryText(doc: StoredReplay): string {
  if (doc.status === 'failed') return `Generation failed: ${doc.error}`;
  if (!doc.replay) return 'Replay is still being written.';
  const deps = doc.replay.dependencies.length;
  const tests = doc.replay.tests.length;
  return [doc.replay.intent.text, `${deps} ${deps === 1 ? 'dependency' : 'dependencies'}`, `${tests} test ${tests === 1 ? 'file' : 'files'}`].join('\n');
}
