import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type Config } from './config.js';
import { buildExportHtml, injectBoot, mermaidPath, readIndexHtml, webDist, writeExport } from './export.js';
import { generate, listReplays, prepareDiff, prepareLocal, preparePr, readReplay, summaryText, waitFor, type StoredReplay } from './generate.js';
import { fetchHead, GitHubError, parsePrUrl } from './github.js';
import { createMcpServer, replayUrl } from './mcp.js';
import { DEPTHS, type Depth } from './schema.js';

export interface ServeOptions {
  cfg: Config;
  host: string;
  port: number;
  hosted: boolean;
  quiet?: boolean;
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: string | object, type = 'application/json; charset=utf-8') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return /^Bearer\s+(.+)$/i.exec(h)?.[1].trim() ?? '';
}

// Platforms put the client address in x-forwarded-for; the limit is a nuisance guard, not security.
function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function origin(req: IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  return `${proto}://${host}`;
}

export function createApp(opts: ServeOptions): Server {
  const { cfg, hosted } = opts;
  const token = process.env.RUNDOWN_TOKEN ?? '';
  const quota = new Map<string, { day: string; n: number }>();
  const heads = new Map<string, { at: number; head: string }>();

  const isAgent = (req: IncomingMessage) => !!token && bearer(req) === token;
  // A bearer that is not RUNDOWN_TOKEN is the caller's own GitHub token, used only for that request.
  const githubToken = (req: IncomingMessage) => {
    const b = bearer(req);
    return b && b !== token ? b : process.env.GITHUB_TOKEN || undefined;
  };
  const limiter = (req: IncomingMessage) => () => {
    if (!hosted || isAgent(req)) return;
    const ip = clientIp(req);
    const day = new Date().toISOString().slice(0, 10);
    const q = quota.get(ip);
    const n = q && q.day === day ? q.n : 0;
    if (n >= 10) throw new HttpError(429, 'Anonymous replays are limited to 10 per day per address. Cached replays are still free.');
    quota.set(ip, { day, n: n + 1 });
  };

  const currentHead = async (doc: StoredReplay): Promise<string | undefined> => {
    const ref = doc.source.pr_url ? parsePrUrl(doc.source.pr_url) : null;
    if (!ref) return undefined;
    const hit = heads.get(doc.source.pr_url!);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.head;
    try {
      const head = await fetchHead(ref, process.env.GITHUB_TOKEN || undefined);
      heads.set(doc.source.pr_url!, { at: Date.now(), head });
      return head;
    } catch {
      return undefined;
    }
  };

  const page = (boot: unknown) => injectBoot(readIndexHtml(), boot);

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    if (token && !isAgent(req)) return send(res, 401, { error: 'This MCP endpoint needs Authorization: Bearer <RUNDOWN_TOKEN>.' });
    const mcp = createMcpServer({ cfg, hosted, baseUrl: () => origin(req), githubToken: githubToken(req), beforeGenerate: limiter(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  };

  const serveStatic = (res: ServerResponse, file: string) => {
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
    createReadStream(file).pipe(res);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        return send(res, 200, page({ mode: 'home', replays: listReplays(), hosted, origin: origin(req) }), MIME['.html']);
      }
      let m: RegExpExecArray | null;
      if (req.method === 'GET' && (m = /^\/r\/([0-9a-f]{12})\.json$/.exec(path))) {
        const doc = readReplay(m[1]);
        if (!doc) return send(res, 404, { error: 'No replay with that id.' });
        const head = doc.status === 'ready' ? await currentHead(doc) : undefined;
        return send(res, 200, { ...doc, ...(head ? { current_head: head } : {}) });
      }
      if (req.method === 'GET' && /^\/r\/([0-9a-f]{12})\/?$/.test(path)) {
        return send(res, 200, page({ mode: 'server', depth: cfg.depth }), MIME['.html']);
      }
      if (req.method === 'GET' && path.startsWith('/assets/')) {
        const file = normalize(join(webDist(), path));
        if (!file.startsWith(webDist())) return send(res, 404, { error: 'Not found.' });
        return serveStatic(res, file);
      }
      if (req.method === 'GET' && path === '/vendor/mermaid.min.js') return serveStatic(res, mermaidPath());
      if (req.method === 'POST' && path === '/generate') {
        return await handleGenerate(await readBody(req), req, res);
      }
      if (req.method === 'POST' && path === '/export') {
        const body = await readBody(req);
        const doc = typeof body.id === 'string' ? readReplay(body.id) : null;
        if (!doc || doc.status !== 'ready') return send(res, 404, { error: 'No finished replay with that id.' });
        const depth: Depth = DEPTHS.includes(body.depth) ? body.depth : cfg.depth;
        if (String(req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(200, { 'content-type': MIME['.html'], 'content-disposition': `attachment; filename="rundown-${doc.id}.html"` });
          return res.end(buildExportHtml(doc, depth));
        }
        const out = writeExport(doc, depth, hosted ? undefined : typeof body.output === 'string' ? body.output : undefined);
        return send(res, 200, { path: out });
      }
      if (path === '/mcp' && ['GET', 'POST', 'DELETE'].includes(req.method ?? '')) return await handleMcp(req, res);
      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof GitHubError ? (err.status === 404 ? 404 : 502) : 400;
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
  });

  async function handleGenerate(body: any, req: IncomingMessage, res: ServerResponse) {
    const depth: Depth | undefined = DEPTHS.includes(body.depth) ? body.depth : undefined;
    let prepared;
    if (typeof body.pr_url === 'string' && body.pr_url) {
      prepared = await preparePr(body.pr_url, githubToken(req));
    } else if (typeof body.diff === 'string' && body.diff) {
      prepared = prepareDiff(body.diff, { transcript: Array.isArray(body.transcript) ? body.transcript.map(String) : undefined });
    } else if (typeof body.repo === 'string' && body.repo) {
      if (hosted) throw new HttpError(400, 'This server is hosted, so it cannot read a local repo. Send pr_url or diff.');
      prepared = prepareLocal(resolve(body.repo), typeof body.base === 'string' && body.base ? body.base : 'main');
    } else {
      throw new HttpError(400, 'Send { pr_url }, { diff }, or { repo, base }.');
    }
    let doc = await generate(prepared, cfg, { wait: false, beforeModel: limiter(req) });
    if (body.wait === true && doc.status === 'pending') doc = (await waitFor(doc.id)) ?? readReplay(doc.id) ?? doc;
    const url = replayUrl(origin(req), doc.id, depth, cfg);
    send(res, 200, { id: doc.id, url, text: summaryText(doc), status: doc.status, ...(doc.error ? { error: doc.error } : {}) });
  }
}

export function serve(opts: ServeOptions): Promise<Server> {
  return new Promise((resolveP, reject) => {
    const server = createApp(opts);
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolveP(server);
    });
  });
}

export function bindHost(): { host: string; hosted: boolean } {
  if (process.env.RUNDOWN_BIND === 'any') {
    console.error('rundown: warning: RUNDOWN_BIND=any, listening on 0.0.0.0. Anyone who can reach this port can use it.');
    return { host: '0.0.0.0', hosted: true };
  }
  if (process.env.RUNDOWN_BIND && process.env.RUNDOWN_BIND !== '127.0.0.1') {
    console.error(`rundown: refusing to bind ${process.env.RUNDOWN_BIND}; only 127.0.0.1, or 0.0.0.0 with RUNDOWN_BIND=any.`);
  }
  return { host: '127.0.0.1', hosted: false };
}

/** Start the local server if the port is free; if it is taken, assume another rundown already serves it. */
export async function ensureLocalServer(cfg = loadConfig(), o: { quiet?: boolean } = {}): Promise<string> {
  const base = `http://127.0.0.1:${cfg.port}`;
  try {
    await serve({ cfg, host: '127.0.0.1', port: cfg.port, hosted: false, quiet: o.quiet });
    if (!o.quiet) console.error(`rundown: serving ${base}`);
    ensureLocalServer.started = true;
  } catch (err: any) {
    if (err?.code !== 'EADDRINUSE') throw err;
  }
  return base;
}
ensureLocalServer.started = false;
