import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { writeExport } from './export.js';
import { appendHookLog, generate, generateFixture, prepareDiff, prepareLocal, preparePr, readReplay, summaryText, type Prepared, type StoredReplay } from './generate.js';
import { replayUrl } from './mcp.js';
import { DEPTHS, type Depth } from './schema.js';

const HELP = `rundown: a median replay of a diff

  rundown <pr-url>                     replay a GitHub pull request
  rundown --local [base]               replay this repo's working tree against base (default main)
  rundown --diff file.patch            replay a unified diff
  rundown --fixture fixtures/sample.patch   render the committed sample, no key, no model call
  rundown --export <id> --output replay.html   write one offline HTML file
  rundown serve                        run the server (127.0.0.1:5200; RUNDOWN_BIND=any for hosting)
  rundown mcp                          stdio MCP server
  rundown hook [pr-url | --local [base] | --diff file]   for agent hooks; always exits 0

  --depth shallow|median|deep          depth the page opens at
  --no-open                            print the URL instead of opening a browser`;

interface Args {
  cmd: 'generate' | 'serve' | 'mcp' | 'hook' | 'export' | 'help';
  prUrl?: string;
  local?: string;
  diff?: string;
  fixture?: string;
  exportId?: string;
  output?: string;
  depth?: Depth;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: 'generate', open: true };
  const rest = [...argv];
  if (rest[0] === 'serve' || rest[0] === 'mcp' || rest[0] === 'hook') a.cmd = rest.shift() as Args['cmd'];
  while (rest.length) {
    const t = rest.shift()!;
    const next = () => {
      const v = rest.shift();
      if (!v) throw new Error(`${t} needs a value`);
      return v;
    };
    if (t === '--help' || t === '-h') a.cmd = 'help';
    else if (t === '--local') a.local = rest[0] && !rest[0].startsWith('-') ? rest.shift()! : 'main';
    else if (t === '--diff') a.diff = next();
    else if (t === '--fixture') a.fixture = next();
    else if (t === '--export') {
      a.exportId = next();
      if (a.cmd === 'generate') a.cmd = 'export';
    } else if (t === '--output' || t === '-o') a.output = next();
    else if (t === '--depth') {
      const d = next() as Depth;
      if (!DEPTHS.includes(d)) throw new Error('--depth must be shallow, median, or deep');
      a.depth = d;
    } else if (t === '--no-open') a.open = false;
    else if (/^https?:\/\//.test(t)) a.prUrl = t;
    else throw new Error(`Unknown argument: ${t}`);
  }
  if (a.cmd === 'generate' && !a.prUrl && !a.local && !a.diff && !a.fixture) a.cmd = 'help';
  return a;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

async function prepare(a: Args, cfg: Config): Promise<Prepared> {
  if (a.prUrl) return preparePr(a.prUrl, process.env.GITHUB_TOKEN || undefined);
  if (a.diff) return prepareDiff(readFileSync(a.diff, 'utf8'), { source: { kind: 'diff', label: a.diff.split('/').pop()! } });
  return prepareLocal(process.cwd(), a.local ?? 'main');
}

async function produce(a: Args, cfg: Config): Promise<StoredReplay> {
  if (a.fixture) return generateFixture(resolve(a.fixture));
  const p = await prepare(a, cfg);
  process.stderr.write(`rundown: ${p.facts.files.length} files, writing the replay with ${cfg.model}…\n`);
  return generate(p, cfg, { wait: true });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (a.cmd === 'help') return console.log(HELP);

  if (a.cmd === 'serve') {
    const { serve, bindHost } = await import('./server.js');
    const { host, hosted } = bindHost();
    const port = Number(process.env.PORT || cfg.port);
    await serve({ cfg, host, port, hosted });
    console.error(`rundown: serving http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (model ${cfg.model}${cfg.apiKey ? '' : ', no key: only the fixture renders'})`);
    return;
  }

  if (a.cmd === 'mcp') {
    const { runStdio } = await import('./mcp.js');
    return runStdio();
  }

  if (a.cmd === 'hook') return hook(a, cfg);

  if (a.cmd === 'export') {
    const doc = readReplay(a.exportId!);
    if (!doc || doc.status !== 'ready') throw new Error(`No finished replay with id ${a.exportId}.`);
    console.log(writeExport(doc, a.depth ?? cfg.depth, a.output));
    return;
  }

  const doc = await produce(a, cfg);
  if (doc.status !== 'ready') {
    console.error(`rundown: ${doc.error ?? 'generation failed'}`);
    process.exit(1);
  }
  const { ensureLocalServer } = await import('./server.js');
  const base = await ensureLocalServer(cfg, { quiet: true });
  const url = replayUrl(base, doc.id, a.depth, cfg);
  console.log(summaryText(doc));
  console.log(url);
  if (a.open) openBrowser(url);
  if (ensureLocalServer.started) console.error('rundown: serving the page from this process; Ctrl-C to stop.');
}

/** For agent hooks: one line out, exit 0 no matter what. */
async function hook(a: Args, cfg: Config) {
  const fail = (msg: string) => {
    const line = msg.split('\n')[0];
    console.log(`rundown: ${line}`);
    try {
      appendHookLog(line);
    } catch {}
    process.exit(0);
  };
  try {
    const remote = process.env.RUNDOWN_URL;
    if (remote) {
      let body: Record<string, unknown>;
      if (a.prUrl) body = { pr_url: a.prUrl };
      else if (a.diff) body = { diff: readFileSync(a.diff, 'utf8') };
      else body = { diff: prepareLocal(process.cwd(), a.local ?? 'main').canonicalDiff };
      const res = await fetch(remote.replace(/\/+$/, '') + '/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.RUNDOWN_TOKEN ? { authorization: `Bearer ${process.env.RUNDOWN_TOKEN}` } : {}) },
        body: JSON.stringify({ ...body, wait: true, ...(a.depth ? { depth: a.depth } : {}) }),
        signal: AbortSignal.timeout(240_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) return fail(json.error || `server returned ${res.status}`);
      if (json.status === 'failed') return fail(json.error || 'generation failed');
      console.log(json.url);
      return process.exit(0);
    }
    if (!a.prUrl && !a.diff && !a.local) a.local = 'main';
    const doc = await produce(a, cfg);
    if (doc.status !== 'ready') return fail(doc.error ?? 'generation failed');
    await startDetachedServer(cfg);
    console.log(replayUrl(`http://127.0.0.1:${cfg.port}`, doc.id, a.depth, cfg));
    process.exit(0);
  } catch (err) {
    fail((err as Error).message);
  }
}

// The hook exits immediately, so the page needs a server that outlives it.
async function startDetachedServer(cfg: Config) {
  await fetch(`http://127.0.0.1:${cfg.port}/`, { signal: AbortSignal.timeout(800) }).catch(() => {
    const bin = fileURLToPath(new URL('../bin/rundown.js', import.meta.url));
    try {
      spawn(process.execPath, [bin, 'serve'], { stdio: 'ignore', detached: true }).unref();
    } catch {}
  });
}

main().catch((err) => {
  console.error(`rundown: ${(err as Error).message}`);
  process.exit(1);
});
