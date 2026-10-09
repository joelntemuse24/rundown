import type { DiffFile } from './diff.js';
import type { Facts } from './facts.js';

export const SCHEMA_VERSION = 1;

export type Depth = 'shallow' | 'median' | 'deep';
export const DEPTHS: Depth[] = ['shallow', 'median', 'deep'];

const INTENT_MAX = 280;
const TITLE_MAX = 120;
const SUMMARY_MAX = 319;

export interface Step {
  id: string;
  title: string;
  summary: string;
  files: Array<{ path: string; lines: string }>;
  importance: 'critical' | 'important' | 'supporting';
}

export interface Replay {
  intent: { text: string; source: 'pr_body' | 'commits' | 'inferred' };
  sequence: Step[];
  dependencies: Array<{ name: string; change: 'added' | 'removed' | 'used'; evidence: string; why: string }>;
  logic: Array<{ id: string; step_id: string; summary: string; evidence: string; failure_mode: string }>;
  tests: Array<{ file: string; locks: string; does_not_cover: string; evidence: string }>;
  open_questions: Array<{ text: string; evidence: string }>;
  functions: Array<{ path: string; name: string; note: string; evidence: string }>;
  diagram: { title: string; mermaid: string };
}

/** How many sequence steps each depth shows, and which slots it reveals. */
export const DEPTH_SLOTS: Record<Depth, { maxSteps: number; narrative: boolean; logic: boolean; questions: boolean; functions: boolean }> = {
  shallow: { maxSteps: 3, narrative: false, logic: false, questions: false, functions: false },
  median: { maxSteps: 8, narrative: true, logic: true, questions: true, functions: false },
  deep: { maxSteps: 12, narrative: true, logic: true, questions: true, functions: true },
};

const RANK = { critical: 0, important: 1, supporting: 2 } as const;

/** Depth is a view: keep the most important steps up to the cap, in their original order. */
export function visibleSteps(seq: Step[], depth: Depth): Step[] {
  const max = DEPTH_SLOTS[depth].maxSteps;
  if (seq.length <= max) return seq;
  const keep = new Set(
    seq.map((s, i) => ({ s, i })).sort((a, b) => RANK[a.s.importance] - RANK[b.s.importance] || a.i - b.i).slice(0, max).map((x) => x.s.id),
  );
  return seq.filter((s) => keep.has(s.id));
}

/** True when call_edges contains a path of at least `length` edges. */
export function hasChain(edges: Facts['call_edges'], length = 3): boolean {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const dfs = (node: string, depth: number, seen: Set<string>): boolean => {
    if (depth >= length) return true;
    for (const next of out.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (dfs(next, depth + 1, seen)) return true;
      seen.delete(next);
    }
    return false;
  };
  return [...out.keys()].some((n) => dfs(n, 0, new Set([n])));
}

export interface ValidationContext {
  facts: Facts;
  files: DiffFile[];
  hasPrBody: boolean;
  hasCommits: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Trim, and cut text that used to be rejected for length. Missing or non-text values become "". */
function asText(v: unknown, max?: number): string {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return max !== undefined && s.length > max ? s.slice(0, max) : s;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function asRecords(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** A diagram the viewer can hand to Mermaid. Anything else is dropped rather than rejected. */
function asMermaid(v: unknown): string {
  const m = asText(v);
  if (!m) return '';
  if (!/^(flowchart|sequenceDiagram)\b/.test(m)) return '';
  if (/<\/?[a-z][^>]*>/i.test(m)) return '';
  return m;
}

/** The import specifier a dependency name refers to: "spec.name", "spec/name", or a name bound by that import line. */
function importSpecFor(name: string, facts: Facts, byPath: Map<string, DiffFile>): string | null {
  const imports = [...facts.imports_added.map((i) => ({ ...i, side: 'new' as const })), ...facts.imports_removed.map((i) => ({ ...i, side: 'old' as const }))];
  const prefixed = imports.filter((i) => name.startsWith(i.specifier + '.') || name.startsWith(i.specifier + '/')).sort((a, b) => b.specifier.length - a.specifier.length);
  if (prefixed.length) return prefixed[0].specifier;
  if (!/^[\w$]+$/.test(name)) return null;
  const word = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  for (const i of imports) {
    const f = byPath.get(i.path);
    const l = f?.hunks.flatMap((h) => h.lines).find((x) => (i.side === 'new' ? x.newNo : x.oldNo) === i.line && x.type !== (i.side === 'new' ? 'del' : 'add'));
    if (l && word.test(l.text.replace(i.specifier, ''))) return i.specifier;
  }
  return null;
}

/**
 * Coerce model output into the shape the viewer renders.
 * Fails only when the JSON is not an object, intent is not an object, or sequence has no step objects.
 * Evidence format, lengths, grounding, and diagram content are normalised, not rejected.
 */
export function validateReplay(raw: unknown, ctx: ValidationContext): { ok: true; replay: Replay } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['(root): expected an object'] };
  const errors: string[] = [];
  if (!isRecord(raw.intent)) errors.push('intent: expected an object');
  if (!Array.isArray(raw.sequence)) errors.push('sequence: expected an array');
  else if (!raw.sequence.some(isRecord)) errors.push('sequence: expected at least one step');
  if (errors.length) return { ok: false, errors };

  const intent = raw.intent as Record<string, unknown>;
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const depNames = new Set([
    ...ctx.facts.manifest_changes.map((m) => m.dependency),
    ...ctx.facts.imports_added.map((m) => m.specifier),
    ...ctx.facts.imports_removed.map((m) => m.specifier),
  ]);

  const sequence = (raw.sequence as unknown[]).filter(isRecord).map((s, i) => ({
    id: asText(s.id) || `s${i + 1}`,
    title: asText(s.title, TITLE_MAX),
    summary: asText(s.summary, SUMMARY_MAX),
    files: asRecords(s.files).map((f) => ({ path: asText(f.path), lines: asText(f.lines) })),
    importance: oneOf(s.importance, ['critical', 'important', 'supporting'] as const, 'supporting'),
  }));

  const dependencies = asRecords(raw.dependencies).map((d) => {
    let name = asText(d.name);
    if (name && !depNames.has(name)) name = importSpecFor(name, ctx.facts, byPath) ?? name;
    return {
      name,
      change: oneOf(d.change, ['added', 'removed', 'used'] as const, 'used'),
      evidence: asText(d.evidence),
      why: asText(d.why),
    };
  });

  const replay: Replay = {
    intent: {
      text: asText(intent.text, INTENT_MAX),
      source: oneOf(intent.source, ['pr_body', 'commits', 'inferred'] as const, 'inferred'),
    },
    sequence,
    dependencies,
    logic: asRecords(raw.logic).map((l, i) => ({
      id: asText(l.id) || `l${i + 1}`,
      step_id: asText(l.step_id),
      summary: asText(l.summary, SUMMARY_MAX),
      evidence: asText(l.evidence),
      failure_mode: asText(l.failure_mode),
    })),
    tests: asRecords(raw.tests).map((t) => ({
      file: asText(t.file),
      locks: asText(t.locks),
      does_not_cover: asText(t.does_not_cover),
      evidence: asText(t.evidence),
    })),
    open_questions: asRecords(raw.open_questions).map((q) => ({ text: asText(q.text), evidence: asText(q.evidence) })),
    functions: asRecords(raw.functions).map((f) => ({
      path: asText(f.path),
      name: asText(f.name),
      note: asText(f.note),
      evidence: asText(f.evidence),
    })),
    diagram: isRecord(raw.diagram) ? { title: asText(raw.diagram.title), mermaid: asMermaid(raw.diagram.mermaid) } : { title: '', mermaid: '' },
  };
  return { ok: true, replay };
}
