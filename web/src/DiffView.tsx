import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { DiffFile, DiffLine, Hunk } from '../../src/diff';
import s from './Diff.module.css';

export const NOISY = (path: string) =>
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|uv\.lock|Pipfile\.lock|composer\.lock)$/.test(path) ||
  /\.lock$/.test(path) ||
  /\.snap$/.test(path) ||
  /\.generated\./.test(path) ||
  /(^|\/)(dist|vendor)\//.test(path);

export function hunkSpan(f: DiffFile, h: Hunk): [number, number] {
  return f.status === 'deleted' ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1];
}

/** Last new-side line of a function body starting at `start`, by indentation. */
export function functionEnd(h: Hunk, start: number): number {
  const lines = h.lines.filter((l) => l.newNo !== null);
  const i = lines.findIndex((l) => l.newNo === start);
  if (i < 0) return start;
  const indent = (t: string) => /^\s*/.exec(t)![0].replace(/\t/g, '    ').length;
  const base = indent(lines[i].text);
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].text;
    if (!t.trim()) continue;
    if (indent(t) <= base) return /^\s*[}\])]|^\s*end\b/.test(t) ? lines[j].newNo! : lines[j - 1].newNo!;
  }
  return lines[lines.length - 1].newNo!;
}

export interface LongFunction {
  name: string;
  start: number;
  end: number;
  note: string;
}

const loc = (f: DiffFile, l: DiffLine) => {
  const n = f.status === 'deleted' ? l.oldNo : l.newNo;
  return n === null ? undefined : `${f.path}:${n}`;
};

function Row({ f, l }: { f: DiffFile; l: DiffLine }) {
  return (
    <div class={`${s.line} ${s[l.type]}`} data-loc={loc(f, l)}>
      <span class={s.no}>{l.oldNo ?? ''}</span>
      <span class={s.no}>{l.newNo ?? ''}</span>
      <span class={s.sign}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
      <code class={s.code}>{l.text || ' '}</code>
    </div>
  );
}

function SplitRows({ f, lines }: { f: DiffFile; lines: DiffLine[] }) {
  const rows: Array<[DiffLine | null, DiffLine | null]> = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type === 'ctx') {
      rows.push([lines[i], lines[i]]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  const cell = (l: DiffLine | null, side: 'old' | 'new') =>
    l ? (
      <div class={`${s.half} ${l.type === 'ctx' ? '' : s[l.type]}`}>
        <span class={s.no}>{side === 'old' ? l.oldNo : l.newNo}</span>
        <code class={s.code}>{l.text || ' '}</code>
      </div>
    ) : (
      <div class={`${s.half} ${s.blank}`} />
    );
  return (
    <>
      {rows.map(([a, b], i) => (
        <div key={i} class={s.splitRow} data-loc={b ? loc(f, b) : a ? loc(f, a) : undefined}>
          {cell(a?.type === 'add' ? null : a, 'old')}
          {cell(b?.type === 'del' ? null : b, 'new')}
        </div>
      ))}
    </>
  );
}

function Lines({ f, lines, split }: { f: DiffFile; lines: DiffLine[]; split: boolean }) {
  if (split) return <SplitRows f={f} lines={lines} />;
  return (
    <>
      {lines.map((l, i) => (
        <Row key={i} f={f} l={l} />
      ))}
    </>
  );
}

export function HunkView({ f, h, split, longFns, children }: { f: DiffFile; h: Hunk; split: boolean; longFns: LongFunction[]; children?: ComponentChildren }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const segments: Array<{ kind: 'lines'; lines: DiffLine[] } | { kind: 'fn'; fn: LongFunction; sig: DiffLine[]; body: DiffLine[] }> = [];
  let buf: DiffLine[] = [];
  for (let i = 0; i < h.lines.length; i++) {
    const l = h.lines[i];
    const fn = l.newNo !== null ? longFns.find((x) => x.start === l.newNo) : undefined;
    if (fn && !open.has(fn.start)) {
      if (buf.length) segments.push({ kind: 'lines', lines: buf });
      buf = [];
      const body: DiffLine[] = [];
      let j = i + 1;
      while (j < h.lines.length && (h.lines[j].newNo === null || h.lines[j].newNo! <= fn.end)) body.push(h.lines[j++]);
      segments.push({ kind: 'fn', fn, sig: [l], body });
      i = j - 1;
      continue;
    }
    buf.push(l);
  }
  if (buf.length) segments.push({ kind: 'lines', lines: buf });

  return (
    <div class={s.hunk}>
      <div class={s.hunkHead}>
        <span>
          @@ {f.status === 'deleted' ? `${h.oldStart}–${h.oldStart + h.oldLines - 1}` : `${h.newStart}–${h.newStart + h.newLines - 1}`}
        </span>
        {h.section && <span class={s.section}>{h.section}</span>}
      </div>
      <div class={s.codeBlock}>
        {segments.map((seg, i) =>
          seg.kind === 'lines' ? (
            <Lines key={i} f={f} lines={seg.lines} split={split} />
          ) : (
            <div key={i} class={s.longFn} data-covers={`${f.path}:${seg.fn.start}-${seg.fn.end}`}>
              <Lines f={f} lines={seg.sig} split={split} />
              {seg.fn.note && <p class={s.fnNote}>{seg.fn.note}</p>}
              <button class={s.disclose} onClick={() => setOpen(new Set(open).add(seg.fn.start))}>
                Show the body of {seg.fn.name} ({seg.body.length} lines)
              </button>
            </div>
          ),
        )}
      </div>
      {children}
    </div>
  );
}

export function FileHeader({ f, editorHref, extra }: { f: DiffFile; editorHref?: string; extra?: ComponentChildren }) {
  const adds = f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0);
  const dels = f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0);
  return (
    <div class={s.fileHead}>
      <span class={s.path}>
        {f.status === 'renamed' && <span class={s.muted}>{f.oldPath} → </span>}
        {f.path}
      </span>
      <span class={s.muted}>
        {f.status !== 'modified' && `${f.status} · `}+{adds} −{dels}
      </span>
      {editorHref && (
        <a class={s.editor} href={editorHref}>
          open in editor
        </a>
      )}
      {extra}
    </div>
  );
}

export function CollapsedFile({ f, cited }: { f: DiffFile; cited: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  return (
    <div class={s.collapsed}>
      <button class={s.disclose} onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} {lines} generated or vendored lines{cited ? ' (cited)' : ''}
      </button>
      {open && f.hunks.map((h, i) => <HunkView key={i} f={f} h={h} split={false} longFns={[]} />)}
    </div>
  );
}
