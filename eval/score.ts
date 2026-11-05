/**
 * Scores one model reply against the facts and the diff, with no model calls.
 * Shared by eval/run.ts and the smoke test in test/eval.test.ts, so what CI checks
 * against the fixture is the same code that scores a live run.
 */
import { lineInHunks, parseDiff, parseEvidence, type DiffFile } from '../src/diff.js';
import type { Facts } from '../src/facts.js';
import { limitsFor } from '../src/prompt.js';

export interface EvalCase {
  name: string;
  facts: Facts;
  files: DiffFile[];
}

export interface Parsed {
  ok: boolean;
  value?: unknown;
}

/** The same tolerance generate.ts applies: one wrapping code fence, otherwise JSON or nothing. */
export function parseFirstReply(content: string): Parsed {
  const t = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

export interface RunScore {
  name: string;
  /** False for every failure path: no saved reply, prose, a second unparseable reply, or a call that threw. */
  parsed: boolean;
  parsedFirst: boolean;
  parsedAfterRepair: boolean;
  evidenceTotal: number;
  evidenceInDiff: number;
  allowedNamesOk: boolean;
  badNames: string[];
  stepCount: number;
  stepCountOk: boolean;
  criticalCount: number;
  criticalOk: boolean;
  logicStepIdsOk: boolean;
  diagramOk: boolean;
  buildsOnOk: boolean;
  promptTokens: number;
  completionTokens: number;
}

export interface Summary {
  cases: number;
  /** Cases with no readable reply. Excluded from every share below. */
  failed: number;
  jsonFirst: number;
  jsonAfterRepair: number;
  evidenceShare: number;
  allowedShare: number;
  shapeShare: number;
  promptTokens: number;
  completionTokens: number;
}

const rows = (v: unknown): any[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Every path:line an answer points at, from the fields the schema asks the model to cite. */
export function evidenceValues(v: any): string[] {
  return [
    ...rows(v?.dependencies).map((d) => str(d.evidence)),
    ...rows(v?.logic).map((l) => str(l.evidence)),
    ...rows(v?.tests).map((t) => str(t.evidence)),
    ...rows(v?.open_questions).map((q) => str(q.evidence)),
    ...rows(v?.functions).map((f) => str(f.evidence)),
  ].filter(Boolean);
}

/** Dependency names are checked against the same union `limitsFor` prints. */
export function allowedDeps(facts: Facts): Set<string> {
  return new Set([...facts.manifest_changes.map((m) => m.dependency), ...facts.imports_added.map((i) => i.specifier), ...facts.imports_removed.map((i) => i.specifier)]);
}

/** Whether the prompt allows a diagram at all, read off the line limitsFor writes. */
export function diagramAllowed(facts: Facts): boolean {
  return limitsFor(facts).split('\n').some((l) => l.startsWith('Diagram: allowed'));
}

export function scoreReply(c: EvalCase, reply: unknown, tokens: { prompt: number; completion: number }, parsedAfterRepair: boolean): RunScore {
  const v: any = reply;
  const ev = evidenceValues(v);
  const inside = ev.filter((e) => {
    const p = parseEvidence(e);
    const f = p && c.files.find((x) => x.path === p.path);
    return !!(p && f && lineInHunks(f, p.line));
  });

  const deps = allowedDeps(c.facts);
  const fns = new Set(c.facts.functions_touched.map((f) => `${f.path}:${f.name}`));
  const tests = new Set(c.facts.test_files);
  const bad: string[] = [];
  for (const d of rows(v?.dependencies)) if (str(d.name) && !deps.has(str(d.name))) bad.push(`dependency ${str(d.name)}`);
  for (const f of rows(v?.functions)) {
    const key = `${str(f.path)}:${str(f.name)}`;
    if (!fns.has(key)) bad.push(`function ${key}`);
  }
  for (const t of rows(v?.tests)) if (str(t.file) && !tests.has(str(t.file))) bad.push(`test ${str(t.file)}`);

  const steps = rows(v?.sequence);
  const stepIndex = new Map(steps.map((s, i) => [str(s.id), i]).filter(([id]) => id !== ''));
  const critical = steps.filter((s) => str(s.importance) === 'critical').length;
  const logicStepIdsOk = rows(v?.logic).every((l) => stepIndex.has(str(l.step_id)));
  const mermaid = str(v?.diagram?.mermaid).trim();
  const diagramOk = mermaid === '' || diagramAllowed(c.facts);

  // builds_on: only ids that exist and come earlier. Phase 2 writes them; a v1 reply has none.
  const buildsOnOk = steps.every((s, i) =>
    (Array.isArray(s.builds_on) ? s.builds_on : []).every((id: unknown) => typeof id === 'string' && stepIndex.has(id) && (stepIndex.get(id) as number) < i),
  );

  return {
    name: c.name,
    parsed: true,
    parsedFirst: !parsedAfterRepair,
    parsedAfterRepair,
    evidenceTotal: ev.length,
    evidenceInDiff: inside.length,
    allowedNamesOk: bad.length === 0,
    badNames: bad,
    stepCount: steps.length,
    stepCountOk: steps.length >= 3 && steps.length <= 8,
    criticalCount: critical,
    criticalOk: critical <= 2,
    logicStepIdsOk,
    diagramOk,
    buildsOnOk,
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
  };
}

/**
 * A case with no readable reply. It counts as failed and contributes nothing to a share:
 * scoring `{}` instead would have reported clean allowed names and an empty, perfect-looking evidence set.
 */
export function failedScore(name: string, tokens: { prompt: number; completion: number }): RunScore {
  return {
    name,
    parsed: false,
    parsedFirst: false,
    parsedAfterRepair: false,
    evidenceTotal: 0,
    evidenceInDiff: 0,
    allowedNamesOk: false,
    badNames: [],
    stepCount: 0,
    stepCountOk: false,
    criticalCount: 0,
    criticalOk: false,
    logicStepIdsOk: false,
    diagramOk: false,
    buildsOnOk: false,
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
  };
}

/** A saved reply from disk. Null means the file is missing; anything that is not JSON is a failure too. */
export function scoreSavedReply(c: EvalCase, raw: string | null, tokens: { prompt: number; completion: number }): RunScore {
  if (raw === null) return failedScore(c.name, tokens);
  const parsed = parseFirstReply(raw);
  return parsed.ok ? scoreReply(c, parsed.value, tokens, false) : failedScore(c.name, tokens);
}

export function summarise(scores: RunScore[]): Summary {
  const ok = scores.filter((s) => s.parsed);
  const n = ok.length || 1;
  const evidenceTotal = ok.reduce((a, s) => a + s.evidenceTotal, 0);
  const evidenceInDiff = ok.reduce((a, s) => a + s.evidenceInDiff, 0);
  const shape = (s: RunScore) => s.stepCountOk && s.criticalOk && s.logicStepIdsOk && s.diagramOk && s.buildsOnOk;
  return {
    cases: scores.length,
    failed: scores.length - ok.length,
    jsonFirst: ok.filter((s) => s.parsedFirst).length,
    jsonAfterRepair: ok.filter((s) => s.parsedAfterRepair).length,
    evidenceShare: evidenceTotal ? evidenceInDiff / evidenceTotal : 0,
    allowedShare: ok.filter((s) => s.allowedNamesOk).length / n,
    shapeShare: ok.filter(shape).length / n,
    promptTokens: scores.reduce((a, s) => a + s.promptTokens, 0),
    completionTokens: scores.reduce((a, s) => a + s.completionTokens, 0),
  };
}

/** One screen: the headline numbers, then a line per case, worst evidence first. */
export function formatSummary(s: Summary, scores: RunScore[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const head = [
    `${s.cases} cases`,
    `JSON first try ${s.jsonFirst}/${s.cases}`,
    `after repair ${s.jsonFirst + s.jsonAfterRepair}/${s.cases}`,
    ...(s.failed ? [`${s.failed} failed`] : []),
    `evidence in diff ${pct(s.evidenceShare)}`,
    `names allowed ${pct(s.allowedShare)}`,
    `shape ok ${pct(s.shapeShare)}`,
    `tokens ${s.promptTokens} in / ${s.completionTokens} out`,
  ].join(' · ');
  const worst = [...scores].sort((a, b) => a.evidenceInDiff / Math.max(1, a.evidenceTotal) - b.evidenceInDiff / Math.max(1, b.evidenceTotal));
  const lines = worst.map((r) => {
    if (!r.parsed) return `${r.name.padEnd(30)} failed: no readable reply`;
    const flags = [
      !r.parsedFirst && (r.parsedAfterRepair ? 'not JSON (repaired)' : 'not JSON'),
      r.evidenceTotal > 0 && r.evidenceInDiff < r.evidenceTotal && `evidence ${r.evidenceInDiff}/${r.evidenceTotal}`,
      !r.allowedNamesOk && `invented ${r.badNames.slice(0, 2).join(', ')}`,
      !r.stepCountOk && `${r.stepCount} steps`,
      !r.criticalOk && `${r.criticalCount} critical`,
      !r.logicStepIdsOk && 'logic step_id',
      !r.diagramOk && 'diagram',
      !r.buildsOnOk && 'builds_on',
    ].filter(Boolean);
    return `${r.name.padEnd(30)} ${flags.length ? flags.join(' · ') : 'ok'}`;
  });
  return [head, '', ...lines].join('\n');
}

export function caseFromDiff(name: string, diff: string, facts: Facts): EvalCase {
  return { name, facts, files: parseDiff(diff) };
}
