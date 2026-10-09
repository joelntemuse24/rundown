import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, type Config } from './config.js';
import { writeExport } from './export.js';
import { generate, prepareDiff, prepareLocal, preparePr, readReplay, summaryText, waitFor, type StoredReplay } from './generate.js';
import { DEPTHS, type Depth } from './schema.js';

export interface McpContext {
  cfg: Config;
  /** Hosted servers only accept pr_url; local paths would read the server's disk. */
  hosted: boolean;
  baseUrl: () => string;
  githubToken?: string;
  /** Called before a new model call; throws when the caller is over its limit. */
  beforeGenerate?: () => void;
}

// MCP clients often time out around a minute; past this the tool returns the URL and the page polls.
const MCP_WAIT_MS = 50_000;

export function replayUrl(base: string, id: string, depth?: Depth, cfg?: Config) {
  return `${base.replace(/\/+$/, '')}/r/${id}${depth && depth !== (cfg?.depth ?? 'median') ? `?depth=${depth}` : ''}`;
}

async function settle(doc: StoredReplay): Promise<StoredReplay> {
  const run = waitFor(doc.id);
  if (!run || doc.status !== 'pending') return doc;
  const timeout = new Promise<StoredReplay>((r) => setTimeout(() => r(doc), MCP_WAIT_MS).unref());
  return Promise.race([run, timeout]);
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'rundown', version: '0.1.0' });

  server.registerTool(
    'explain_change',
    {
      description:
        'Write a Rundown replay of a code change and return its URL: the order the change landed in, the libraries it depends on, where the logic branches, and what the tests lock. Pass pr_url for a GitHub pull request (works with no local checkout), or base / patch_path for a local repo.',
      inputSchema: {
        repo: z.string().describe('Path to the local repository, or owner/repo when passing pr_url'),
        pr_url: z.string().optional().describe('GitHub pull request URL'),
        base: z.string().optional().describe('Base ref to diff the working tree against (default main)'),
        patch_path: z.string().optional().describe('Path to a unified diff file'),
        depth: z.enum(['shallow', 'median', 'deep']).optional(),
      },
    },
    async (args) => {
      try {
        const sources = [args.pr_url, args.base, args.patch_path].filter((x) => x !== undefined);
        if (sources.length > 1) throw new Error('Pass exactly one of pr_url, base, or patch_path.');
        let prepared;
        if (args.pr_url) prepared = await preparePr(args.pr_url, ctx.githubToken);
        else if (ctx.hosted) throw new Error('This server is hosted: pass pr_url. Local paths only work with the stdio server.');
        else if (args.patch_path) {
          const p = isAbsolute(args.patch_path) ? args.patch_path : resolve(args.repo || '.', args.patch_path);
          prepared = prepareDiff(readFileSync(p, 'utf8'), { source: { kind: 'diff', label: args.patch_path } });
        } else prepared = prepareLocal(resolve(args.repo || '.'), args.base || 'main');

        const doc = await settle(await generate(prepared, ctx.cfg, { wait: false, beforeModel: ctx.beforeGenerate }));
        const depth = args.depth && DEPTHS.includes(args.depth) ? args.depth : undefined;
        const result = { url: replayUrl(ctx.baseUrl(), doc.id, depth, ctx.cfg), summary: summaryText(doc), id: doc.id };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: doc.status === 'failed' };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
      }
    },
  );

  server.registerTool(
    'export_replay',
    {
      description: 'Write a Rundown replay to a single offline HTML file and return its path.',
      inputSchema: {
        id: z.string().describe('Replay id (the 12 hex characters in /r/:id)'),
        output: z.string().optional().describe('Output file path'),
      },
    },
    async (args) => {
      const doc = readReplay(args.id);
      if (!doc || doc.status !== 'ready') return { content: [{ type: 'text' as const, text: `No finished replay with id ${args.id}.` }], isError: true };
      const path = writeExport(doc, ctx.cfg.depth, ctx.hosted ? undefined : args.output);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ path }) }] };
    },
  );

  return server;
}

/** Local stdio server. The viewer URL points at the local HTTP server, which this process starts if it is free. */
export async function runStdio() {
  const cfg = loadConfig();
  const { ensureLocalServer } = await import('./server.js');
  const base = await ensureLocalServer(cfg, { quiet: true });
  const server = createMcpServer({ cfg, hosted: false, baseUrl: () => base, githubToken: process.env.GITHUB_TOKEN });
  await server.connect(new StdioServerTransport());
}
