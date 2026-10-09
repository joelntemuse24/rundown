import { z } from 'zod';
import { lineInHunks, parseEvidence, parseLineRange, type DiffFile } from './diff.js';
import type { Facts } from './facts.js';

export const SCHEMA_VERSION = 1;

export type Depth = 'shallow' | 'median' | 'deep';
export const DEPTHS: Depth[] = ['shallow', 'median', 'deep'];

const evidence = z.string().regex(/^.+:\d+$/, 'evidence must be "path:line"');
const text = z.string().refine((s) => !/[•●▪◦]|(^|\n)\s*[-*]\s/.test(s), 'no bullet characters inside strings');

export const replaySchema = z
  .object({
    intent: z.object({
      text: text.pipe(z.string().min(40).max(280)),
      source: z.enum(['pr_body', 'commits', 'inferred']),
    }).strict(),
    sequence: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1).max(120),
          summary: text.pipe(z.string().min(1).max(319)),
          files: z.array(z.object({ path: z.string(), lines: z.string() }).strict()).min(1),
          importance: z.enum(['critical', 'important', 'supporting']),
        }).strict(),
      )
      .min(3)
      .max(12),
    dependencies: z.array(
      z.object({
        name: z.string().min(1),
        change: z.enum(['added', 'removed', 'used']),
        evidence,
        why: text,
      }).strict(),
    ),
    logic: z.array(
      z.object({ id: z.string(), step_id: z.string(), summary: text.pipe(z.string().max(319)), evidence, failure_mode: text }).strict(),
    ),
    tests: z.array(z.object({ file: z.string(), locks: text, does_not_cover: text, evidence }).strict()),
    open_questions: z.array(z.object({ text, evidence }).strict()).max(3),
    functions: z.array(z.object({ path: z.string(), name: z.string(), note: text, evidence }).strict()),
    diagram: z.object({ title: z.string(), mermaid: z.string() }).strict(),
  })
  .strict();

export type Replay = z.infer<typeof replaySchema>;
export type Step = Replay['sequence'][number];

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

export function countSentences(s: string): number {
  return (s.trim().match(/[.!?](?=\s+[A-Z`"'(]|\s*$)/g) ?? []).length || 1;
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

export function factSymbols(facts: Facts): Set<string> {
  const s = new Set<string>();
  for (const f of facts.functions_touched) s.add(f.name);
  for (const e of facts.call_edges) {
    for (const end of [e.from, e.to]) {
      s.add(end);
      s.add(end.slice(end.lastIndexOf(':') + 1));
    }
  }
  return s;
}

/** Labels of the nodes/participants in a Mermaid source, best effort. */
export function mermaidLabels(src: string): string[] {
  const labels: string[] = [];
  const body = src.split('\n').slice(1).join('\n');
  if (/^\s*sequenceDiagram/.test(src)) {
    for (const m of body.matchAll(/^\s*(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/gm)) labels.push((m[2] ?? m[1]).trim());
    for (const m of body.matchAll(/^\s*([^\s:>-]+)\s*-[->x)]+[+-]?\s*([^\s:]+)\s*:/gm)) labels.push(m[1], m[2]);
  } else {
    const nodeRe = /([A-Za-z_][\w]*)\s*(?:\[\[|\[\(|\(\(|\[|\(|\{|>)\s*"?([^\]\)\}"]*)"?\s*(?:\]\]|\)\]|\)\)|\]|\)|\})/g;
    const labelled = new Set<string>();
    for (const m of body.matchAll(nodeRe)) {
      labels.push(m[2].trim());
      labelled.add(m[1]);
    }
    const stripped = body.replace(nodeRe, '$1').replace(/\|[^|]*\|/g, ' ');
    for (const m of stripped.matchAll(/(?:^|-->|---|-\.->|==>|&)\s*([A-Za-z_][\w]*)/gm)) {
      if (!labelled.has(m[1]) && !['subgraph', 'end', 'flowchart', 'direction'].includes(m[1])) labels.push(m[1]);
    }
  }
  return [...new Set(labels.filter(Boolean))];
}

export interface ValidationContext {
  facts: Facts;
  files: DiffFile[];
  hasPrBody: boolean;
  hasCommits: boolean;
}

/** Shape check plus grounding: every path, line, dependency, symbol must come from the facts. */
export function validateReplay(raw: unknown, ctx: ValidationContext): { ok: true; replay: Replay } | { ok: false; errors: string[] } {
  const parsed = replaySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const r = parsed.data;
  const errors: string[] = [];
  const { facts } = ctx;
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const known = (p: string) => facts.files.some((f) => f.path === p);

  const checkEvidence = (where: string, ev: string) => {
    const e = parseEvidence(ev);
    if (!e) return errors.push(`${where}: evidence "${ev}" is not path:line`);
    if (!known(e.path)) return errors.push(`${where}: path "${e.path}" is not in the diff`);
    const f = byPath.get(e.path);
    if (f && !lineInHunks(f, e.line)) errors.push(`${where}: line ${e.line} is outside every hunk of ${e.path}; use the new-file line number`);
  };

  if (r.intent.source === 'pr_body' && !ctx.hasPrBody) errors.push('intent.source: pr_body given but no PR body was provided');
  if (r.intent.source === 'commits' && !ctx.hasCommits) errors.push('intent.source: commits given but no commit subjects were provided');
  if (r.intent.source === 'inferred' && (ctx.hasPrBody || ctx.hasCommits)) errors.push('intent.source: inferred is only allowed when no PR body or commit message was provided');

  const ids = new Set<string>();
  r.sequence.forEach((s, i) => {
    const w = `sequence[${i}]`;
    if (ids.has(s.id)) errors.push(`${w}.id: duplicate id ${s.id}`);
    ids.add(s.id);
    if (countSentences(s.summary) > 2) errors.push(`${w}.summary: at most 2 sentences`);
    s.files.forEach((sf, j) => {
      if (!known(sf.path)) return errors.push(`${w}.files[${j}]: path "${sf.path}" is not in the diff`);
      const rg = parseLineRange(sf.lines);
      if (!rg) return errors.push(`${w}.files[${j}].lines: must look like "12-40"`);
      const f = byPath.get(sf.path);
      if (f && f.hunks.length && !f.hunks.some((h) => {
        const [a, b] = f.status === 'deleted' ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.newStart, h.newStart + h.newLines - 1];
        return rg[0] <= b && rg[1] >= a;
      })) errors.push(`${w}.files[${j}].lines: ${sf.lines} does not overlap any hunk of ${sf.path}`);
    });
  });
  if (r.sequence.filter((s) => s.importance === 'critical').length > 2) errors.push('sequence: at most two steps may be critical');

  const depNames = new Set([
    ...facts.manifest_changes.map((m) => m.dependency),
    ...facts.imports_added.map((m) => m.specifier),
    ...facts.imports_removed.map((m) => m.specifier),
  ]);
  const manifestAdded = new Set(facts.manifest_changes.filter((m) => m.change === 'added').map((m) => m.dependency));
  r.dependencies.forEach((d, i) => {
    if (!depNames.has(d.name)) errors.push(`dependencies[${i}]: "${d.name}" is not in manifest_changes, imports_added, or imports_removed`);
    // A bare package marked "added" must be a new manifest entry; otherwise it is merely "used".
    else if (d.change === 'added' && !d.name.startsWith('.') && !d.name.startsWith('/') && !manifestAdded.has(d.name) && facts.manifest_changes.length > 0) {
      errors.push(`dependencies[${i}]: "${d.name}" is not added in any manifest; mark it "used"`);
    }
    checkEvidence(`dependencies[${i}]`, d.evidence);
  });

  r.logic.forEach((l, i) => {
    if (!ids.has(l.step_id)) errors.push(`logic[${i}].step_id: no step "${l.step_id}"`);
    if (countSentences(l.summary) > 2) errors.push(`logic[${i}].summary: at most 2 sentences`);
    checkEvidence(`logic[${i}]`, l.evidence);
  });

  if (facts.test_files.length === 0 && r.tests.length) errors.push('tests: must be [] because the diff has no test files');
  r.tests.forEach((t, i) => {
    if (!facts.test_files.includes(t.file)) errors.push(`tests[${i}].file: "${t.file}" is not in test_files`);
    checkEvidence(`tests[${i}]`, t.evidence);
  });

  r.open_questions.forEach((q, i) => checkEvidence(`open_questions[${i}]`, q.evidence));

  r.functions.forEach((f, i) => {
    if (!facts.functions_touched.some((t) => t.name === f.name && t.path === f.path)) errors.push(`functions[${i}]: ${f.path}:${f.name} is not in functions_touched`);
    checkEvidence(`functions[${i}]`, f.evidence);
  });

  const m = r.diagram.mermaid.trim();
  if (m) {
    if (!hasChain(facts.call_edges)) errors.push('diagram.mermaid: must be "" because call_edges has no chain of three edges');
    if (!/^(flowchart|sequenceDiagram)\b/.test(m)) errors.push('diagram.mermaid: must start with flowchart or sequenceDiagram');
    if (/^\s*(style|classDef|class|click|linkStyle)\b/m.test(m) || m.includes(':::') || /%%\{/.test(m)) errors.push('diagram.mermaid: no styling directives or click events');
    if (/<\/?[a-z][^>]*>/i.test(m)) errors.push('diagram.mermaid: no HTML labels');
    const symbols = factSymbols(facts);
    for (const label of mermaidLabels(m)) {
      if (!symbols.has(label)) errors.push(`diagram.mermaid: node "${label}" is not a symbol from the facts`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, replay: r };
}

const PRUNABLE = /^(dependencies|logic|tests|open_questions|functions)\[(\d+)\]/;

/**
 * Strict validation, then drop ungrounded optional entries instead of failing on them.
 * Intent and sequence errors are never pruned; those still fail.
 */
export function groundReplay(
  raw: unknown,
  ctx: ValidationContext,
): { ok: true; replay: Replay; dropped: string[] } | { ok: false; errors: string[] } {
  const first = validateReplay(raw, ctx);
  if (first.ok) return { ok: true, replay: first.replay, dropped: [] };
  if (!replaySchema.safeParse(raw).success) return first;

  const r = structuredClone(replaySchema.parse(raw));
  const drop = new Map<string, Set<number>>();
  let clearDiagram = false;
  let clearTests = false;
  for (const e of first.errors) {
    const m = PRUNABLE.exec(e);
    if (m) {
      if (!drop.has(m[1])) drop.set(m[1], new Set());
      drop.get(m[1])!.add(Number(m[2]));
    } else if (e.startsWith('diagram.')) clearDiagram = true;
    else if (e.startsWith('tests:')) clearTests = true;
    else return first;
  }
  const keep = <T>(arr: T[], key: string) => arr.filter((_, i) => !drop.get(key)?.has(i));
  r.dependencies = keep(r.dependencies, 'dependencies');
  r.logic = keep(r.logic, 'logic');
  r.tests = clearTests ? [] : keep(r.tests, 'tests');
  r.open_questions = keep(r.open_questions, 'open_questions');
  r.functions = keep(r.functions, 'functions');
  if (clearDiagram) r.diagram = { title: '', mermaid: '' };

  const second = validateReplay(r, ctx);
  return second.ok ? { ok: true, replay: second.replay, dropped: first.errors } : second;
}
