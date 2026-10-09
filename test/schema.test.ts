import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFacts } from '../src/facts.js';
import { parseModelJson } from '../src/generate.js';
import { validateReplay, visibleSteps, type Replay } from '../src/schema.js';

const fixtures = new URL('../fixtures/', import.meta.url);
const patch = readFileSync(new URL('sample.patch', fixtures), 'utf8');
const replay: Replay = JSON.parse(readFileSync(new URL('sample.replay.json', fixtures), 'utf8'));
const r = extractFacts({ diff: patch });
const ctx = { facts: r.facts, files: r.files, hasPrBody: false, hasCommits: false };
const clone = (): Replay => structuredClone(replay);
const errorsOf = (doc: unknown) => {
  const v = validateReplay(doc, ctx);
  return v.ok ? [] : v.errors;
};

describe('fixture replay', () => {
  it('validates against the fixture facts', () => {
    expect(errorsOf(replay)).toEqual([]);
  });

  it('names express-rate-limit and says the test misses the fail-open path', () => {
    expect(replay.dependencies.map((d) => d.name)).toContain('express-rate-limit');
    expect(replay.tests).toHaveLength(1);
    expect(replay.tests[0].does_not_cover.toLowerCase()).toContain('fail-open');
  });
});

describe('every committed replay names only dependencies from its facts', () => {
  for (const f of readdirSync(fixtures).filter((n) => n.endsWith('.replay.json'))) {
    it(f, () => {
      const doc: Replay = JSON.parse(readFileSync(new URL(f, fixtures), 'utf8'));
      const facts = extractFacts({ diff: readFileSync(new URL(f.replace('.replay.json', '.patch'), fixtures), 'utf8') }).facts;
      const allowed = new Set([...facts.manifest_changes.map((m) => m.dependency), ...facts.imports_added.map((i) => i.specifier), ...facts.imports_removed.map((i) => i.specifier)]);
      for (const d of doc.dependencies) expect(allowed.has(d.name), `${d.name} is not in the facts`).toBe(true);
    });
  }
});

describe('validator', () => {
  it('accepts a messy model output as a ready replay', () => {
    const doc = clone();
    doc.sequence[1].summary = `One. Two. Three. ${'x'.repeat(400)}`;
    doc.sequence[1].files[0].path = 'src/nowhere.js';
    doc.logic[0].evidence = 'see the middleware';
    doc.dependencies.push({ name: 'helmet', change: 'added', evidence: 'not a path:line', why: 'Security headers.' });
    doc.functions[0].name = 'handleLogin';
    doc.tests.push({ file: 'test/missing.test.js', locks: 'nothing', does_not_cover: 'the rest', evidence: 'nope' });
    doc.diagram = { title: 'Nope', mermaid: 'this is not a diagram\n  A --> B' };
    const v = validateReplay(doc, ctx);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.replay.sequence[1].summary.length).toBeLessThanOrEqual(319);
    expect(v.replay.sequence[1].summary.startsWith('One. Two. Three.')).toBe(true);
    expect(v.replay.sequence[1].files[0].path).toBe('src/nowhere.js');
    expect(v.replay.logic[0].evidence).toBe('see the middleware');
    expect(v.replay.dependencies.map((d) => d.name)).toContain('helmet');
    expect(v.replay.functions[0].name).toBe('handleLogin');
    expect(v.replay.tests.map((t) => t.file)).toContain('test/missing.test.js');
    expect(v.replay.diagram).toEqual({ title: 'Nope', mermaid: '' });
  });

  it('truncates a long intent and keeps a short one, bullets, and an unearned source', () => {
    const short = clone();
    short.intent.text = 'Too short.';
    short.intent.source = 'pr_body';
    const s = validateReplay(short, ctx);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.replay.intent).toEqual({ text: 'Too short.', source: 'pr_body' });

    const long = clone();
    long.intent.text = 'y'.repeat(400);
    long.sequence[2].summary = '- a bullet';
    const v = validateReplay(long, ctx);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.replay.intent.text).toHaveLength(280);
    expect(v.replay.sequence[2].summary).toBe('- a bullet');
  });

  it('keeps extra critical steps, questions, tests, and a diagram the facts do not earn', () => {
    const doc = clone();
    doc.sequence.forEach((step) => (step.importance = 'critical'));
    doc.open_questions = Array.from({ length: 4 }, () => doc.open_questions[0]);
    doc.diagram.mermaid = 'flowchart LR\n  A[buildAuthRouter] --> B[redisCluster]';
    const noTests = { ...ctx, facts: { ...ctx.facts, test_files: [], call_edges: ctx.facts.call_edges.slice(0, 2) } };
    const v = validateReplay(doc, noTests);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.replay.sequence.every((step) => step.importance === 'critical')).toBe(true);
    expect(v.replay.open_questions).toHaveLength(4);
    expect(v.replay.tests).toHaveLength(replay.tests.length);
    expect(v.replay.diagram.mermaid).toContain('redisCluster');
  });

  it('coerces missing optional sections and fails only when the page cannot render', () => {
    const sparse = {
      intent: { text: '  Adds a limiter.  ' },
      sequence: [{ title: 'x'.repeat(200), summary: 12, importance: 'urgent' }, 'skip me'],
    };
    const v = validateReplay(sparse, ctx);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.replay.intent).toEqual({ text: 'Adds a limiter.', source: 'inferred' });
    expect(v.replay.sequence).toEqual([
      { id: 's1', title: 'x'.repeat(120), summary: '12', files: [], importance: 'supporting' },
    ]);
    expect(v.replay.dependencies).toEqual([]);
    expect(v.replay.logic).toEqual([]);
    expect(v.replay.tests).toEqual([]);
    expect(v.replay.open_questions).toEqual([]);
    expect(v.replay.functions).toEqual([]);
    expect(v.replay.diagram).toEqual({ title: '', mermaid: '' });

    expect(validateReplay(null, ctx).ok).toBe(false);
    expect(validateReplay({ intent: { text: 'hi' } }, ctx).ok).toBe(false);
    expect(validateReplay({ intent: 'nope', sequence: [{ id: 's1' }] }, ctx).ok).toBe(false);
    expect(validateReplay({ intent: { text: 'hi' }, sequence: [] }, ctx).ok).toBe(false);
  });

  it('rejects prose', () => {
    expect(() => parseModelJson('Here is the replay you asked for.')).toThrow();
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('spells out the allowed sets in the prompt', async () => {
    const { limitsFor } = await import('../src/prompt.js');
    const text = limitsFor(r.facts);
    expect(text).toContain('express-rate-limit');
    expect(text).toContain('Diagram: allowed');
    expect(limitsFor({ ...r.facts, call_edges: [] })).toContain('Diagram: not allowed');
  });
});

describe('python dependency names map back to their import', () => {
  const diff = [
    'diff --git a/tests/test_bot.py b/tests/test_bot.py',
    '--- a/tests/test_bot.py',
    '+++ b/tests/test_bot.py',
    '@@ -1,2 +1,3 @@',
    ' import unittest',
    '+from buy.mint_sell import dump_fast_retry_eligible',
    ' ',
    '',
  ].join('\n');
  const py = extractFacts({ diff });
  const pctx = { facts: py.facts, files: py.files, hasPrBody: false, hasCommits: false };
  const base = (name: string): Replay => ({
    ...clone(),
    dependencies: [{ name, change: 'used', evidence: 'tests/test_bot.py:2', why: 'The test calls the real predicate.' }],
  });

  for (const name of ['buy.mint_sell', 'buy.mint_sell.dump_fast_retry_eligible', 'dump_fast_retry_eligible']) {
    it(name, () => {
      const v = validateReplay(base(name), pctx);
      expect(v.ok ? [] : v.errors).toEqual([]);
      if (v.ok) expect(v.replay.dependencies[0].name).toBe('buy.mint_sell');
    });
  }

  it('keeps a name the import does not bind', () => {
    const v = validateReplay(base('requests'), pctx);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.replay.dependencies[0].name).toBe('requests');
  });
});

describe('depth is a view', () => {
  it('keeps the most important steps in order', () => {
    expect(visibleSteps(replay.sequence, 'deep')).toHaveLength(6);
    expect(visibleSteps(replay.sequence, 'median')).toHaveLength(6);
    expect(visibleSteps(replay.sequence, 'shallow').map((s) => s.id)).toEqual(['s2', 's3', 's5']);
  });
});
