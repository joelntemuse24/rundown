import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const patch = readFileSync(new URL('../fixtures/sample.patch', import.meta.url), 'utf8');
const replay = JSON.parse(readFileSync(new URL('../fixtures/sample.replay.json', import.meta.url), 'utf8'));
const hasViewer = existsSync(new URL('../web/dist/index.html', import.meta.url));

let mock: Server;
let app: Server;
let base = '';
const calls: Array<{ auth: string; messages: any[] }> = [];

/** One server plays both the model endpoint and the GitHub REST API. */
function startMock(): Promise<string> {
  mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const url = req.url ?? '';
    if (url === '/v1/chat/completions') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ auth: String(req.headers.authorization), messages: body.messages });
      const first = body.messages.length === 2;
      const hasBody = body.messages[1].content.includes('PR body:');
      const content = first ? 'Sure! This change adds rate limiting to the login route.' : JSON.stringify({ ...replay, intent: { ...replay.intent, source: hasBody ? 'pr_body' : 'inferred' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    }
    if (url.startsWith('/repos/acme/api/pulls/7/commits')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ commit: { message: 'Rate-limit login\n\nbody' } }]));
    }
    if (url === '/repos/acme/api/pulls/7') {
      if (String(req.headers.accept).includes('diff')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(patch.replace('"^7.4.0"', '"^7.4.1"'));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ title: 'Rate-limit login', body: 'Adds a limiter in front of POST /auth/login.', base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } }));
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => mock.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(mock.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  const m = await startMock();
  process.env.RUNDOWN_CACHE_DIR = mkdtempSync(join(tmpdir(), 'rundown-test-'));
  process.env.RUNDOWN_BASE_URL = `${m}/v1`;
  process.env.RUNDOWN_API_KEY = 'sk-test-secret';
  process.env.RUNDOWN_MODEL = 'mock';
  process.env.GITHUB_API_URL = m;
  const { serve } = await import('../src/server.js');
  const { loadConfig } = await import('../src/config.js');
  app = await serve({ cfg: loadConfig(), host: '127.0.0.1', port: 0, hosted: false });
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(() => {
  app?.close();
  mock?.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe.skipIf(!hasViewer)('server', () => {
  let id = '';

  it('rejects prose, repairs once, and returns the three-line text', async () => {
    const res = await post('/generate', { diff: patch, wait: true });
    const json: any = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('ready');
    expect(json.url).toMatch(/\/r\/[0-9a-f]{12}$/);
    expect(json.text.split('\n')).toEqual([replay.intent.text, '3 dependencies', '1 test file']);
    expect(calls).toHaveLength(2);
    expect(calls[0].messages[1].content.startsWith('full\n')).toBe(true);
    id = json.id;
  });

  it('never writes the key into the replay or the log', async () => {
    const doc = await (await fetch(`${base}/r/${id}.json`)).text();
    expect(doc).not.toContain('sk-test-secret');
    const dir = process.env.RUNDOWN_CACHE_DIR!;
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(join(dir, 'logs'))) expect(readFileSync(join(dir, 'logs', f), 'utf8')).not.toContain('sk-test-secret');
  });

  it('serves the same diff from cache, and depth never calls the model', async () => {
    const json: any = await (await post('/generate', { diff: patch, depth: 'deep' })).json();
    expect(json.id).toBe(id);
    expect(json.url).toMatch(/\?depth=deep$/);
    for (const d of ['shallow', 'median', 'deep']) {
      expect((await fetch(`${base}/r/${id}?depth=${d}`)).status).toBe(200);
      expect((await fetch(`${base}/r/${id}.json`)).status).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });

  it('lists the replay on the homepage', async () => {
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain(id);
  });

  it('answers explain_change over HTTP MCP with only a pr_url', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['explain_change', 'export_replay']);
    const result: any = await client.callTool({ name: 'explain_change', arguments: { repo: 'acme/api', pr_url: 'https://github.com/acme/api/pull/7' } });
    expect(result.isError).toBeFalsy();
    const out = JSON.parse(result.content[0].text);
    expect(out.url).toMatch(new RegExp(`^${base}/r/[0-9a-f]{12}$`));
    expect(out.summary).toContain('3 dependencies');
    const doc: any = await (await fetch(`${base}/r/${out.id}.json`)).json();
    expect(doc.source.pr_url).toBe('https://github.com/acme/api/pull/7');
    expect(doc.replay.intent.source).toBe('pr_body');
    expect(doc.facts.head).toBe('b'.repeat(40));
    await client.close();
  });

  it('exports one HTML file with the JSON inlined and Mermaid beside it', async () => {
    const json: any = await (await post('/export', { id, output: join(process.env.RUNDOWN_CACHE_DIR!, 'out', 'replay.html') })).json();
    const html = readFileSync(json.path, 'utf8');
    expect(html).toContain('"mode":"export"');
    expect(html).not.toMatch(/src="\/assets|href="\/assets|127\.0\.0\.1|localhost/);
    expect(existsSync(join(dirname(json.path), 'rundown-vendor', 'mermaid.min.js'))).toBe(true);
  });

  it('turns bad input into a readable error', async () => {
    const res = await post('/generate', { pr_url: 'https://example.com/nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/pull request URL/);
  });
});
