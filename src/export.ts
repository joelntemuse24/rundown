import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir } from './config.js';
import { packageRoot, type StoredReplay } from './generate.js';
import { presentReplay, type Depth } from './schema.js';

export const webDist = () => join(packageRoot, 'web', 'dist');

export function mermaidPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('mermaid'))), 'mermaid.min.js');
}

export function readIndexHtml(): string {
  const p = join(webDist(), 'index.html');
  if (!existsSync(p)) throw new Error('The viewer is not built. Run `pnpm build` first.');
  return readFileSync(p, 'utf8');
}

export function injectBoot(html: string, boot: unknown): string {
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return html.replace(/(<script id="rundown-data" type="application\/json">)null(<\/script>)/, (_, a, b) => a + json + b);
}

/** One HTML file: JSON, CSS, and JS inlined. Mermaid, if needed, is a relative vendor file. */
export function buildExportHtml(doc: StoredReplay, depth: Depth): string {
  let html = readIndexHtml();
  const dist = webDist();
  html = html.replace(/<script type="module"[^>]*src="\/?(assets\/[^"]+\.js)"[^>]*><\/script>/, (_, src) => {
    const js = readFileSync(join(dist, src), 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script type="module">${js}</script>`;
  });
  html = html.replace(/<link rel="stylesheet"[^>]*href="\/?(assets\/[^"]+\.css)"[^>]*>/, (_, href) => `<style>${readFileSync(join(dist, href), 'utf8')}</style>`);
  const { current_head: _ignored, ...clean } = doc as StoredReplay & { current_head?: string };
  return injectBoot(html, { mode: 'export', doc: clean, depth });
}

export function needsMermaid(doc: StoredReplay): boolean {
  return presentReplay(doc.replay).diagramMermaid.trim().length > 0;
}

export function writeExport(doc: StoredReplay, depth: Depth, output?: string): string {
  const out = resolve(output || join(cacheDir(), 'exports', `rundown-${doc.id}.html`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildExportHtml(doc, depth));
  if (needsMermaid(doc)) {
    const vendor = join(dirname(out), 'rundown-vendor');
    mkdirSync(vendor, { recursive: true });
    copyFileSync(mermaidPath(), join(vendor, 'mermaid.min.js'));
  }
  return out;
}
