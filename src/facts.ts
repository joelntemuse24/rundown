import { createHash } from 'node:crypto';
import { canonicalize, parseDiff, type DiffFile, type DiffLine } from './diff.js';

export type ImportKind = 'esm' | 'cjs' | 'py' | 'go' | 'rust' | 'other';

export interface Facts {
  diff_hash: string;
  base: string;
  head: string;
  files: Array<{ path: string; status: DiffFile['status']; additions: number; deletions: number; old_path: string }>;
  imports_added: Array<{ path: string; specifier: string; line: number; kind: ImportKind }>;
  imports_removed: Array<{ path: string; specifier: string; line: number }>;
  manifest_changes: Array<{ file: string; dependency: string; change: 'added' | 'removed' | 'bumped'; from: string; to: string }>;
  test_files: string[];
  functions_touched: Array<{ path: string; name: string; line: number; status: 'added' | 'modified' }>;
  call_edges: Array<{ from: string; to: string; line: number }>;
  commands_observed: string[];
}

export interface FactsInput {
  diff: string;
  base?: string;
  head?: string;
  transcript?: string[];
}

export interface FactsResult {
  facts: Facts;
  canonicalDiff: string;
  files: DiffFile[];
  /** Function body ranges, used by the prompt to summarise large new files. */
  functionRanges: Map<string, FunctionRange[]>;
}

export interface FunctionRange {
  name: string;
  start: number;
  end: number;
  status: 'added' | 'modified' | null;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const basename = (p: string) => p.split('/').pop() ?? p;
const ext = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};

type Lang = 'js' | 'py' | 'go' | 'rust' | 'ruby' | 'other';
function langOf(path: string): Lang {
  const e = ext(path);
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'].includes(e)) return 'js';
  if (e === 'py' || e === 'pyi') return 'py';
  if (e === 'go') return 'go';
  if (e === 'rs') return 'rust';
  if (e === 'rb') return 'ruby';
  return 'other';
}

export function isTestFile(path: string): boolean {
  const p = '/' + path;
  const b = basename(path);
  return (
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/__tests__/') ||
    /\.(test|spec)\.[^/]+$/.test(b) ||
    b.endsWith('_test.go') ||
    /^test_.*\.py$/.test(b)
  );
}

export const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'go.sum',
  'poetry.lock', 'Gemfile.lock', 'uv.lock', 'Pipfile.lock', 'composer.lock',
]);
const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile']);

// ---------- imports ----------

interface ImportHit {
  specifier: string;
  kind: ImportKind;
  bindings: string[];
}

function jsBindings(clause: string): string[] {
  const out: string[] = [];
  const brace = /\{([^}]*)\}/.exec(clause);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[\w$]+$/.test(name)) out.push(name);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+([\w$]+)/, (_, n) => (out.push(n), ''));
  for (const part of rest.split(',')) {
    const n = part.trim().replace(/^type\s+/, '');
    if (/^[\w$]+$/.test(n)) out.push(n);
  }
  return out;
}

function importsInLine(text: string, lang: Lang, state: { goBlock: boolean }): ImportHit[] {
  const hits: ImportHit[] = [];
  if (lang === 'js') {
    let m = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(text);
    if (m) hits.push({ specifier: m[2], kind: 'esm', bindings: jsBindings(m[1]) });
    else if ((m = /^\s*import\s+['"]([^'"]+)['"]/.exec(text))) hits.push({ specifier: m[1], kind: 'esm', bindings: [] });
    else if ((m = /^\s*export\s+.+?\s+from\s+['"]([^'"]+)['"]/.exec(text))) hits.push({ specifier: m[1], kind: 'esm', bindings: [] });
    const req = /(?:(?:const|let|var)\s+([\w${},\s:]+?)\s*=\s*)?require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let r: RegExpExecArray | null;
    while ((r = req.exec(text))) {
      hits.push({ specifier: r[2], kind: 'cjs', bindings: r[1] ? jsBindings(r[1].replace(/:\s*[\w$]+/g, '')) : [] });
    }
    const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((r = dyn.exec(text))) hits.push({ specifier: r[1], kind: 'esm', bindings: [] });
  } else if (lang === 'py') {
    let m = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(text);
    if (m) {
      const names = m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter((s) => /^\w+$/.test(s));
      hits.push({ specifier: m[1], kind: 'py', bindings: names });
    } else if ((m = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*$/.exec(text))) {
      for (const part of m[1].split(',')) {
        const [spec, alias] = part.trim().split(/\s+as\s+/);
        hits.push({ specifier: spec, kind: 'py', bindings: [alias ?? spec.split('.')[0]] });
      }
    }
  } else if (lang === 'go') {
    if (/^\s*import\s*\(\s*$/.test(text)) {
      state.goBlock = true;
      return hits;
    }
    if (state.goBlock && /^\s*\)\s*$/.test(text)) {
      state.goBlock = false;
      return hits;
    }
    const m = state.goBlock ? /^\s*(?:([\w.]+)\s+)?"([^"]+)"/.exec(text) : /^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/.exec(text);
    if (m) hits.push({ specifier: m[2], kind: 'go', bindings: [m[1] ?? m[2].split('/').pop()!] });
  } else if (lang === 'rust') {
    let m = /^\s*(?:pub\s+)?use\s+([\w:]+)(?:::\{([^}]*)\})?/.exec(text);
    if (m) {
      const root = m[1].replace(/::$/, '');
      const names = m[2] ? m[2].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!) : [root.split('::').pop()!];
      hits.push({ specifier: root.split('::')[0], kind: 'rust', bindings: names.filter((n) => /^\w+$/.test(n)) });
    } else if ((m = /^\s*extern\s+crate\s+(\w+)/.exec(text))) hits.push({ specifier: m[1], kind: 'rust', bindings: [m[1]] });
  } else if (lang === 'ruby') {
    const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(text);
    if (m) hits.push({ specifier: m[1], kind: 'other', bindings: [] });
  }
  return hits;
}

// ---------- functions ----------

const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'super', 'constructor']);

function declName(text: string, lang: Lang): string | null {
  let m: RegExpExecArray | null = null;
  if (lang === 'js') {
    m =
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*[<(]/.exec(text) ||
      /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/.exec(text) ||
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/.exec(text);
  } else if (lang === 'py') {
    m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(text) || /^\s*class\s+(\w+)/.exec(text);
  } else if (lang === 'go') {
    m = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*[\[(]/.exec(text);
  } else if (lang === 'rust') {
    m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/.exec(text);
  } else if (lang === 'ruby') {
    m = /^\s*def\s+(?:self\.)?(\w+[?!]?)/.exec(text);
  }
  if (!m || RESERVED.has(m[1])) return null;
  return m[1];
}

function functionRanges(f: DiffFile, lang: Lang): FunctionRange[] {
  const out: FunctionRange[] = [];
  for (const h of f.hunks) {
    const visible = h.lines.map((l, idx) => ({ l, idx })).filter(({ l }) => l.type !== 'del');
    const decls: Array<{ name: string; vi: number }> = [];
    visible.forEach(({ l }, vi) => {
      const n = declName(l.text, lang);
      if (n) decls.push({ name: n, vi });
    });
    const indent = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, '    ').length;
    decls.forEach((d, di) => {
      const startIdx = visible[d.vi].idx;
      let endIdx = di + 1 < decls.length ? visible[decls[di + 1].vi].idx - 1 : h.lines.length - 1;
      // The body ends at the first later line indented no deeper than the declaration.
      const base = indent(h.lines[startIdx].text);
      for (let i = startIdx + 1; i <= endIdx; i++) {
        const l = h.lines[i];
        if (l.type === 'del' || !l.text.trim()) continue;
        if (indent(l.text) <= base) {
          endIdx = /^\s*[}\])]|^\s*end\b/.test(l.text) ? i : i - 1;
          break;
        }
      }
      const body = h.lines.slice(startIdx, endIdx + 1);
      const declLine = h.lines[startIdx];
      let status: FunctionRange['status'] = null;
      if (f.status === 'added' || declLine.type === 'add') status = 'added';
      else if (body.some((l) => l.type !== 'ctx')) status = 'modified';
      const newNos = body.map((l) => l.newNo).filter((n): n is number => n !== null);
      out.push({ name: d.name, start: declLine.newNo!, end: Math.max(...newNos), status });
    });
  }
  return out;
}

// ---------- manifests ----------

type Dep = { name: string; version: string };
const PKG_DEP_SECTIONS = /^(dependencies|devDependencies|peerDependencies|optionalDependencies)$/;
const PKG_NON_DEP_KEYS = new Set(['name', 'version', 'main', 'module', 'types', 'type', 'license', 'description', 'private', 'packageManager']);

function manifestDeps(file: string, lines: DiffLine[], side: 'add' | 'del'): Dep[] {
  const b = basename(file);
  const out: Dep[] = [];
  let section = '';
  let goBlock = false;
  for (const l of lines) {
    if (l.type !== 'ctx' && l.type !== side) continue;
    const t = l.text;
    let sec: RegExpExecArray | null;
    if (b === 'package.json') {
      if ((sec = /^\s*"([^"]+)"\s*:\s*\{/.exec(t))) section = sec[1];
      if (l.type !== side) continue;
      const m = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(t);
      if (!m) continue;
      if (section ? PKG_DEP_SECTIONS.test(section) : !PKG_NON_DEP_KEYS.has(m[1]) && /^[\^~<>=*\dvwnfgl]/.test(m[2])) {
        out.push({ name: m[1], version: m[2] });
      }
    } else if (b === 'requirements.txt') {
      if (l.type !== side) continue;
      const m = /^\s*([A-Za-z0-9][\w.\-\[\]]*)\s*((?:[=<>!~]=?|===).*)?$/.exec(t.split('#')[0]);
      if (m && !t.trim().startsWith('-')) out.push({ name: m[1].replace(/\[.*\]/, ''), version: (m[2] ?? '').trim() });
    } else if (b === 'pyproject.toml' || b === 'Cargo.toml') {
      if ((sec = /^\s*\[([^\]]+)\]/.exec(t))) section = sec[1];
      if (l.type !== side) continue;
      const isDepSection = /dependencies/.test(section);
      const kv = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(?:"([^"]*)"|\{.*?version\s*=\s*"([^"]*)".*\}|\{.*\})/.exec(t);
      if (kv && isDepSection && kv[1] !== 'python') out.push({ name: kv[1], version: kv[2] ?? kv[3] ?? '' });
      const arr = /^\s*"([A-Za-z0-9][\w.\-\[\]]*)\s*([^"]*)"\s*,?\s*$/.exec(t);
      if (arr && b === 'pyproject.toml' && (isDepSection || section === 'project')) out.push({ name: arr[1].replace(/\[.*\]/, ''), version: arr[2].trim() });
    } else if (b === 'go.mod') {
      if (/^\s*require\s*\(\s*$/.test(t)) goBlock = true;
      else if (goBlock && /^\s*\)\s*$/.test(t)) goBlock = false;
      if (l.type !== side) continue;
      const m = goBlock ? /^\s*([\w.\-/]+)\s+(v[\w.\-+]+)/.exec(t) : /^\s*require\s+([\w.\-/]+)\s+(v[\w.\-+]+)/.exec(t);
      if (m) out.push({ name: m[1], version: m[2] });
    } else if (b === 'Gemfile') {
      if (l.type !== side) continue;
      const m = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(t);
      if (m) out.push({ name: m[1], version: m[2] ?? '' });
    }
  }
  return out;
}

// ---------- main ----------

export function extractFacts(input: FactsInput): FactsResult {
  const parsed = parseDiff(input.diff);
  const { text: canonicalDiff, files } = canonicalize(parsed);

  const facts: Facts = {
    diff_hash: sha256(canonicalDiff),
    base: input.base ?? '',
    head: input.head ?? '',
    files: [],
    imports_added: [],
    imports_removed: [],
    manifest_changes: [],
    test_files: [],
    functions_touched: [],
    call_edges: [],
    commands_observed: input.transcript ? [...input.transcript] : [],
  };
  const ranges = new Map<string, FunctionRange[]>();
  // Per file: local binding name -> specifier, for newly added imports only.
  const newBindings = new Map<string, Map<string, string>>();

  for (const f of files) {
    const all = f.hunks.flatMap((h) => h.lines);
    facts.files.push({
      path: f.path,
      status: f.status,
      additions: all.filter((l) => l.type === 'add').length,
      deletions: all.filter((l) => l.type === 'del').length,
      old_path: f.status === 'renamed' ? f.oldPath : '',
    });
    if (isTestFile(f.path)) facts.test_files.push(f.path);

    try {
      const lang = langOf(f.path);
      const binds = new Map<string, string>();
      const addState = { goBlock: false };
      const delState = { goBlock: false };
      for (const l of all) {
        if (l.type !== 'del') {
          for (const hit of importsInLine(l.text, lang, addState)) {
            if (l.type !== 'add') continue;
            facts.imports_added.push({ path: f.path, specifier: hit.specifier, line: l.newNo!, kind: hit.kind });
            for (const b of hit.bindings) binds.set(b, hit.specifier);
          }
        }
        if (l.type !== 'add') {
          for (const hit of importsInLine(l.text, lang, delState)) {
            if (l.type === 'del') facts.imports_removed.push({ path: f.path, specifier: hit.specifier, line: l.oldNo! });
          }
        }
      }
      newBindings.set(f.path, binds);

      if (MANIFESTS.has(basename(f.path))) {
        const added = manifestDeps(f.path, all, 'add');
        const removed = manifestDeps(f.path, all, 'del');
        for (const a of added) {
          const r = removed.find((x) => x.name === a.name);
          if (r) {
            if (r.version !== a.version) facts.manifest_changes.push({ file: f.path, dependency: a.name, change: 'bumped', from: r.version, to: a.version });
          } else facts.manifest_changes.push({ file: f.path, dependency: a.name, change: 'added', from: '', to: a.version });
        }
        for (const r of removed) {
          if (!added.some((a) => a.name === r.name)) facts.manifest_changes.push({ file: f.path, dependency: r.name, change: 'removed', from: r.version, to: '' });
        }
      }

      if (f.status !== 'deleted' && !LOCKFILES.has(basename(f.path))) {
        const fr = functionRanges(f, lang);
        ranges.set(f.path, fr);
        for (const r of fr) {
          if (r.status) facts.functions_touched.push({ path: f.path, name: r.name, line: r.start, status: r.status });
        }
      }
    } catch {
      // One file failing extraction must not fail the run; it stays in `files` without symbols.
    }
  }

  facts.call_edges = callEdges(files, ranges, newBindings, facts);
  return { facts, canonicalDiff, files, functionRanges: ranges };
}

function callEdges(files: DiffFile[], ranges: Map<string, FunctionRange[]>, binds: Map<string, Map<string, string>>, facts: Facts): Facts['call_edges'] {
  const edges: Facts['call_edges'] = [];
  const seen = new Set<string>();
  const touched = facts.functions_touched;
  for (const f of files) {
    const fr = ranges.get(f.path) ?? [];
    const fileBinds = binds.get(f.path) ?? new Map<string, string>();
    for (const r of fr) {
      if (!r.status) continue;
      const from = `${f.path}:${r.name}`;
      const lines = f.hunks.flatMap((h) => h.lines).filter((l) => l.newNo !== null && l.newNo > r.start && l.newNo <= r.end);
      for (const l of lines) {
        const call = /(?<![.\w$])([\w$]+)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = call.exec(l.text))) {
          const name = m[1];
          if (name === r.name || RESERVED.has(name)) continue;
          let to: string | null = null;
          if (touched.some((t) => t.path === f.path && t.name === name)) to = `${f.path}:${name}`;
          else if (fileBinds.has(name)) {
            const spec = fileBinds.get(name)!;
            const target = touched.find((t) => t.name === name && t.path !== f.path && resolves(f.path, spec, t.path));
            to = target ? `${target.path}:${name}` : `${spec}:${name}`;
          }
          if (!to) continue;
          const key = `${from}->${to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from, to, line: l.newNo! });
        }
      }
    }
  }
  return edges;
}

function resolves(fromPath: string, spec: string, target: string): boolean {
  if (!spec.startsWith('.')) return false;
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const resolved = parts.join('/');
  const strip = (p: string) => p.replace(/\.(m?[jt]sx?|cjs|cts|mts)$/, '').replace(/\/index$/, '');
  return strip(resolved) === strip(target);
}