import type { Facts } from './facts.js';

export const SCHEMA_VERSION = 1;

export type Depth = 'shallow' | 'median' | 'deep';
export const DEPTHS: Depth[] = ['shallow', 'median', 'deep'];

/** The shape the prompt asks for. Stored replays are whatever JSON the model returned. */
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

const RANK: Record<string, number> = { critical: 0, important: 1, supporting: 2 };

/** Depth is a view: keep the most important steps up to the cap, in their original order. */
export function visibleSteps<T extends { id: string; importance?: string }>(seq: T[], depth: Depth): T[] {
  const max = DEPTH_SLOTS[depth].maxSteps;
  if (seq.length <= max) return seq;
  const rank = (importance?: string) => (importance !== undefined && importance in RANK ? RANK[importance] : 3);
  const keep = new Set(
    seq.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.importance) - rank(b.s.importance) || a.i - b.i).slice(0, max).map((x) => x.s.id),
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

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A string field as the model wrote it. Anything else is shown as nothing. */
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function rows(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item) => {
    const row = record(item);
    return row ? [row] : [];
  });
}

export interface PresentedStep {
  id: string;
  title: string;
  summary: string;
  files: Array<{ path: string; lines: string }>;
  importance: string;
}

export interface PresentedReplay {
  intentText: string;
  intentSource: string;
  steps: PresentedStep[];
  dependencies: Array<{ name: string; change: string; evidence: string; why: string }>;
  logic: Array<{ id: string; step_id: string; summary: string; evidence: string; failure_mode: string }>;
  tests: Array<{ file: string; locks: string; does_not_cover: string; evidence: string }>;
  openQuestions: Array<{ text: string; evidence: string }>;
  functions: Array<{ path: string; name: string; note: string; evidence: string }>;
  diagramTitle: string;
  diagramMermaid: string;
}

/**
 * A read-only view of model JSON for the page. Missing or non-string fields become empty.
 * The stored replay is not changed.
 */
export function presentReplay(raw: unknown): PresentedReplay {
  const root = record(raw);
  const intent = record(root?.intent);
  const diagram = record(root?.diagram);
  return {
    intentText: text(intent?.text),
    intentSource: text(intent?.source),
    steps: rows(root?.sequence).map((s, i) => ({
      id: text(s.id) || `s${i + 1}`,
      title: text(s.title),
      summary: text(s.summary),
      files: rows(s.files).map((f) => ({ path: text(f.path), lines: text(f.lines) })),
      importance: text(s.importance),
    })),
    dependencies: rows(root?.dependencies).map((d) => ({
      name: text(d.name),
      change: text(d.change),
      evidence: text(d.evidence),
      why: text(d.why),
    })),
    logic: rows(root?.logic).map((l, i) => ({
      id: text(l.id) || `l${i + 1}`,
      step_id: text(l.step_id),
      summary: text(l.summary),
      evidence: text(l.evidence),
      failure_mode: text(l.failure_mode),
    })),
    tests: rows(root?.tests).map((t) => ({
      file: text(t.file),
      locks: text(t.locks),
      does_not_cover: text(t.does_not_cover),
      evidence: text(t.evidence),
    })),
    openQuestions: rows(root?.open_questions).map((q) => ({ text: text(q.text), evidence: text(q.evidence) })),
    functions: rows(root?.functions).map((f) => ({
      path: text(f.path),
      name: text(f.name),
      note: text(f.note),
      evidence: text(f.evidence),
    })),
    diagramTitle: text(diagram?.title),
    diagramMermaid: text(diagram?.mermaid),
  };
}
