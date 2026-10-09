// Unified diff parsing and canonicalisation. No Node APIs: the viewer imports this too.

export type LineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: LineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(p: string): string {
  // Drop trailing timestamps ("file\t2024-01-01 ...") and the a/ b/ prefixes.
  let s = p.split('\t')[0].trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s === '/dev/null') return s;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

export function parseDiff(text: string): DiffFile[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const startFile = (): DiffFile => {
    const f: DiffFile = { path: '', oldPath: '', status: 'modified', binary: false, hunks: [] };
    files.push(f);
    hunk = null;
    return f;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === ' ' || (line === '' && i < lines.length - 1)) {
        hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === '+') {
        hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
        newLeft--;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
        oldLeft--;
        continue;
      }
      if (c === '\\') continue;
      hunk = null;
    } else if (hunk && line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('diff --git ')) {
      cur = startFile();
      const m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      if (m) {
        cur.oldPath = stripPrefix(m[1]);
        cur.path = stripPrefix(m[2]);
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) continue;
      if (!cur || cur.hunks.length > 0) cur = startFile();
      const oldP = stripPrefix(line.slice(4));
      const newP = stripPrefix(next.slice(4));
      if (oldP === '/dev/null') cur.status = 'added';
      else cur.oldPath = oldP;
      if (newP === '/dev/null') cur.status = 'deleted';
      else cur.path = newP;
      if (cur.status === 'deleted') cur.path = cur.oldPath;
      if (cur.status === 'added') cur.oldPath = cur.path;
      i++;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length);
      cur.status = 'renamed';
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
    } else {
      const m = HUNK_RE.exec(line);
      if (m) {
        hunk = {
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          section: m[5] ?? '',
          lines: [],
        };
        cur.hunks.push(hunk);
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        oldLeft = hunk.oldLines;
        newLeft = hunk.newLines;
      }
    }
  }

  for (const f of files) {
    if (f.status === 'deleted') f.path = f.path || f.oldPath;
    if (!f.oldPath) f.oldPath = f.path;
    if (f.status === 'modified' && f.oldPath !== f.path) f.status = 'renamed';
  }
  return files.filter((f) => f.path);
}

/** Re-cut hunks so every hunk carries at most `context` lines around changes. */
function recut(h: Hunk, context: number): Hunk[] {
  const changeIdx = h.lines.map((l, i) => (l.type === 'ctx' ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return [];
  const keep = new Array(h.lines.length).fill(false);
  for (const i of changeIdx) {
    for (let j = Math.max(0, i - context); j <= Math.min(h.lines.length - 1, i + context); j++) keep[j] = true;
  }
  const out: Hunk[] = [];
  let cur: DiffLine[] = [];
  const flush = () => {
    if (!cur.length) return;
    const firstOld = cur.find((l) => l.oldNo !== null)?.oldNo;
    const firstNew = cur.find((l) => l.newNo !== null)?.newNo;
    const oldLines = cur.filter((l) => l.type !== 'add').length;
    const newLines = cur.filter((l) => l.type !== 'del').length;
    out.push({
      oldStart: oldLines === 0 ? lastOldBefore(h, cur[0]) : (firstOld ?? 0),
      oldLines,
      newStart: newLines === 0 ? lastNewBefore(h, cur[0]) : (firstNew ?? 0),
      newLines,
      section: out.length === 0 ? h.section : '',
      lines: cur,
    });
    cur = [];
  };
  h.lines.forEach((l, i) => {
    if (keep[i]) cur.push(l);
    else flush();
  });
  flush();
  return out;
}

// For a pure insertion/deletion, the empty side's start is the line before it.
function lastOldBefore(h: Hunk, first: DiffLine): number {
  const idx = h.lines.indexOf(first);
  for (let i = idx - 1; i >= 0; i--) if (h.lines[i].oldNo !== null) return h.lines[i].oldNo!;
  return Math.max(0, h.oldStart - 1);
}
function lastNewBefore(h: Hunk, first: DiffLine): number {
  const idx = h.lines.indexOf(first);
  for (let i = idx - 1; i >= 0; i--) if (h.lines[i].newNo !== null) return h.lines[i].newNo!;
  return Math.max(0, h.newStart - 1);
}

function range(start: number, n: number): string {
  return n === 1 ? `${start}` : `${start},${n}`;
}

/** Timestamps stripped, files sorted by path, context unified to three lines. */
export function canonicalize(files: DiffFile[]): { text: string; files: DiffFile[] } {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outFiles: DiffFile[] = [];
  const parts: string[] = [];
  for (const f of sorted) {
    const hunks = f.hunks.flatMap((h) => recut(h, 3));
    const nf: DiffFile = { ...f, hunks };
    outFiles.push(nf);
    const head: string[] = [`diff --git a/${f.oldPath} b/${f.path}`];
    if (f.status === 'added') head.push('new file mode 100644');
    if (f.status === 'deleted') head.push('deleted file mode 100644');
    if (f.status === 'renamed') head.push(`rename from ${f.oldPath}`, `rename to ${f.path}`);
    if (f.binary) {
      head.push(`Binary files a/${f.oldPath} and b/${f.path} differ`);
      parts.push(head.join('\n'));
      continue;
    }
    if (hunks.length) {
      head.push(f.status === 'added' ? '--- /dev/null' : `--- a/${f.oldPath}`);
      head.push(f.status === 'deleted' ? '+++ /dev/null' : `+++ b/${f.path}`);
    }
    for (const h of hunks) {
      head.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${h.section ? ' ' + h.section : ''}`);
      for (const l of h.lines) head.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text);
    }
    parts.push(head.join('\n'));
  }
  return { text: parts.join('\n') + '\n', files: outFiles };
}

/** Line ranges each file's evidence may point into: new side, or old side for deleted files. */
export function evidenceRanges(f: DiffFile): Array<[number, number]> {
  if (f.status === 'deleted') return f.hunks.map((h) => [h.oldStart, h.oldStart + h.oldLines - 1]);
  return f.hunks.filter((h) => h.newLines > 0).map((h) => [h.newStart, h.newStart + h.newLines - 1]);
}

export function lineInHunks(f: DiffFile, line: number): boolean {
  return evidenceRanges(f).some(([a, b]) => line >= a && line <= b);
}

export function parseEvidence(ev: string): { path: string; line: number } | null {
  const m = /^(.+):(\d+)$/.exec(ev.trim());
  if (!m) return null;
  return { path: m[1], line: Number(m[2]) };
}

export function parseLineRange(lines: string): [number, number] | null {
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(lines.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return a <= b ? [a, b] : [b, a];
}
