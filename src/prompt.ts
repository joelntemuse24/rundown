import type { DiffFile } from './diff.js';
import { isTestFile, LOCKFILES, type Facts, type FunctionRange } from './facts.js';
import type { ChatMessage } from './model.js';
import { hasChain } from './schema.js';

export const SYSTEM_PROMPT = `You write a median replay of a code diff for a human who did not write it.
You fill a JSON schema. You do not review, praise, or suggest refactors.
The facts JSON is authoritative. Every dependency, path, symbol, and test file
you name must appear in the facts. If a fact is absent, omit the claim.
Order sequence by what a reader must understand first, not by filename.
Describe control flow and failure behavior only when the diff shows it.
Mark intent source as inferred only when no PR body and no commit message was provided.
Return one JSON object and nothing else. No markdown fence, no prose before or after it.
Every evidence value is path:line. Summaries are one or two sentences.
Name a dependency or function only when the facts list it. A diagram is valid Mermaid or "".`;

export const SCHEMA_TEXT = `Return one JSON object with exactly these keys. Use [] or "" when a section is empty.

Quality:
- Evidence, everywhere it appears, is "path:line". The line is the new-file line number inside a hunk after the patch, never a position in the diff text and never a sentence.
- Summaries are concise: one or two sentences, under 320 characters, with no bullet characters. intent.text is one or two sentences, about 40 to 280 characters. Step titles are under 120 characters.
- dependencies[].name must be copied from manifest_changes, imports_added, or imports_removed. Do not invent packages, config keys, or imported function names. "added" only for a new manifest entry or a new local module; otherwise "used".
- functions[].path and functions[].name must match an entry in functions_touched. Do not name any other function. Write one note for each entry.
- diagram.mermaid is "" unless call_edges contains a chain of three edges. When you draw one, it must be valid Mermaid starting with "flowchart" or "sequenceDiagram". Node labels are bare symbol names from the facts. No styling, no click events, no HTML. diagram.title is a short label, or "" when mermaid is "".

Shape:
{
  "intent": { "text": "", "source": "pr_body|commits|inferred" },
  "sequence": [{ "id": "s1", "title": "", "summary": "", "files": [{ "path": "", "lines": "12-40" }], "importance": "critical|important|supporting" }],
  "dependencies": [{ "name": "", "change": "added|removed|used", "evidence": "path:line", "why": "" }],
  "logic": [{ "id": "l1", "step_id": "s1", "summary": "", "evidence": "path:line", "failure_mode": "" }],
  "tests": [{ "file": "", "locks": "", "does_not_cover": "", "evidence": "path:line" }],
  "open_questions": [{ "text": "", "evidence": "path:line" }],
  "functions": [{ "path": "", "name": "", "note": "", "evidence": "path:line" }],
  "diagram": { "title": "", "mermaid": "" }
}
sequence has 3 to 8 steps, ordered for a reader, at most two of them "critical".
intent.source is "pr_body" only when a PR body was provided, "commits" only when commit subjects were provided and there is no PR body, otherwise "inferred".
files[].path is a path from the diff. files[].lines is a new-file range inside a hunk, like "12-40" or "11".
logic.step_id is the id of a sequence step. failure_mode only when the diff shows the failure.
tests: one entry per file in test_files, or [] if there are none. Say plainly what each does not cover.
open_questions: 0 to 3, each about something the diff does not answer, with evidence in a file from the diff.`;

export const DIFF_BUDGET = 80_000;
const MANIFEST = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile)$/;

function renderFile(f: DiffFile): string {
  const out = [`diff --git a/${f.oldPath} b/${f.path}`];
  if (f.status === 'added') out.push('new file');
  if (f.status === 'deleted') out.push('deleted file');
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}`);
    for (const l of h.lines) out.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text);
  }
  return out.join('\n');
}

function summariseLargeNewFile(f: DiffFile, ranges: FunctionRange[]): string {
  const lines = f.hunks.flatMap((h) => h.lines);
  const sigs = ranges.filter((r) => r.status).map((r) => `  ${r.name} (line ${r.start}-${r.end})`);
  return [
    `diff --git a/${f.path} b/${f.path}`,
    'new file',
    `[rundown: new file of ${lines.length} lines, shown as signatures plus first and last 40 lines]`,
    'signatures:',
    ...sigs,
    `@@ -0,0 +1,40 @@`,
    ...lines.slice(0, 40).map((l) => '+' + l.text),
    `[rundown: lines 41-${lines.length - 40} omitted]`,
    `@@ -0,0 +${lines.length - 39},40 @@`,
    ...lines.slice(-40).map((l) => '+' + l.text),
  ].join('\n');
}

/** Manifests and tests whole first, then source files, then lockfiles; cut is marked. */
export function truncateDiff(files: DiffFile[], ranges: Map<string, FunctionRange[]>, budget = DIFF_BUDGET): string {
  const rank = (f: DiffFile) => {
    const base = f.path.split('/').pop()!;
    if (LOCKFILES.has(base)) return 3;
    if (MANIFEST.test(f.path)) return 0;
    if (isTestFile(f.path)) return 1;
    return 2;
  };
  const ordered = files.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
  const parts: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of ordered) {
    const lineCount = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    const text = f.status === 'added' && lineCount > 400 ? summariseLargeNewFile(f, ranges.get(f.path) ?? []) : renderFile(f);
    if (used + text.length + 1 > budget) {
      omitted.push(f.path);
      continue;
    }
    parts.push(text);
    used += text.length + 1;
  }
  if (omitted.length) parts.push(`[rundown: diff truncated at ${budget} characters; omitted files: ${omitted.join(', ')}]`);
  return parts.join('\n');
}

export interface PromptContext {
  title?: string;
  body?: string;
  commits?: string[];
}

/** The closed sets from the facts, spelled out so the model copies names instead of inventing them. */
export function limitsFor(facts: Facts): string {
  const deps = [...new Set([...facts.manifest_changes.map((m) => m.dependency), ...facts.imports_added.map((i) => i.specifier), ...facts.imports_removed.map((i) => i.specifier)])];
  const fns = facts.functions_touched.map((f) => `${f.path}:${f.name}`);
  return [
    `Allowed dependency names (nothing else, not config keys or settings): ${deps.length ? deps.join(', ') : 'none, so dependencies must be []'}`,
    `Allowed function names for functions and diagram nodes: ${fns.length ? fns.join(', ') : 'none, so functions must be []'}`,
    `Allowed test files: ${facts.test_files.length ? facts.test_files.join(', ') : 'none, so tests must be []'}`,
    hasChain(facts.call_edges) ? 'Diagram: allowed; call_edges contains a chain of three edges.' : 'Diagram: not allowed. call_edges has no chain of three edges, so diagram must be {"title": "", "mermaid": ""}.',
  ].join('\n');
}

export function buildMessages(facts: Facts, files: DiffFile[], ranges: Map<string, FunctionRange[]>, ctx: PromptContext): ChatMessage[] {
  const sections = ['full', SCHEMA_TEXT, limitsFor(facts), 'Facts:\n' + JSON.stringify(facts, null, 2)];
  if (ctx.title || ctx.body) sections.push(`PR title: ${ctx.title ?? ''}\nPR body:\n${ctx.body?.trim() || '(empty)'}`);
  if (ctx.commits?.length) sections.push('Commit subjects:\n' + ctx.commits.join('\n'));
  sections.push('Unified diff:\n' + truncateDiff(files, ranges));
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

export function repairMessages(original: ChatMessage[], badOutput: string, errors: string[]): ChatMessage[] {
  return [
    ...original,
    { role: 'assistant', content: badOutput.slice(0, 20_000) },
    {
      role: 'user',
      content: `That reply was not JSON.\n${errors.slice(0, 40).join('\n')}\n\nReturn one JSON object only. No prose, no markdown fence.`,
    },
  ];
}
