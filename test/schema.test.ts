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
  it('rejects a dependency absent from the facts', () => {
    const doc = clone();
    doc.dependencies.push({ name: 'helmet', change: 'added', evidence: 'package.json:11', why: 'Security headers.' });
    expect(errorsOf(doc).join()).toMatch(/helmet/);
  });

  it('rejects calling an existing package newly added', () => {
    const doc = clone();
    doc.dependencies.push({ name: 'supertest', change: 'added', evidence: 'test/loginLimiter.test.js:1', why: 'HTTP assertions.' });
    expect(errorsOf(doc).join()).toMatch(/supertest.*used/);
  });

  it('rejects hallucinated paths', () => {
    const doc = clone();
    doc.sequence[0].files[0].path = 'src/app.js';
    expect(errorsOf(doc).join()).toMatch(/not in the diff/);
  });

  it('rejects evidence outside every hunk (diff-index numbers)', () => {
    const doc = clone();
    doc.logic[0].evidence = 'src/routes/auth.js:40';
    expect(errorsOf(doc).join()).toMatch(/outside every hunk/);
  });

  it('allows at most two critical steps', () => {
    const doc = clone();
    doc.sequence.forEach((s) => (s.importance = 'critical'));
    expect(errorsOf(doc).join()).toMatch(/two steps/);
  });

  it('enforces intent length and source', () => {
    const doc = clone();
    doc.intent.text = 'Too short.';
    expect(errorsOf(doc).join()).toMatch(/intent\.text/);
    const doc2 = clone();
    doc2.intent.source = 'pr_body';
    expect(errorsOf(doc2).join()).toMatch(/no PR body/);
  });

  it('rejects three-sentence summaries and bullets', () => {
    const doc = clone();
    doc.sequence[1].summary = 'One. Two. Three.';
    expect(errorsOf(doc).join()).toMatch(/2 sentences/);
    const doc2 = clone();
    doc2.sequence[2].summary = '- a bullet';
    expect(errorsOf(doc2).join()).toMatch(/bullet/);
  });

  it('requires tests to be [] when the diff has no test files', () => {
    const noTests = { ...ctx, facts: { ...ctx.facts, test_files: [] } };
    const v = validateReplay(replay, noTests);
    expect(v.ok).toBe(false);
  });

  it('caps open questions at three', () => {
    const doc = clone();
    doc.open_questions = Array(4).fill(doc.open_questions[0]);
    expect(errorsOf(doc).length).toBeGreaterThan(0);
  });

  it('only accepts functions from functions_touched', () => {
    const doc = clone();
    doc.functions[0].name = 'handleLogin';
    expect(errorsOf(doc).join()).toMatch(/functions_touched/);
  });

  it('rejects a diagram without a three-edge chain, styling, or foreign labels', () => {
    const noChain = { ...ctx, facts: { ...ctx.facts, call_edges: ctx.facts.call_edges.slice(0, 2) } };
    const v = validateReplay(replay, noChain);
    expect(v.ok ? '' : v.errors.join()).toMatch(/chain of three/);

    const styled = clone();
    styled.diagram.mermaid += '\n  style A fill:#f00';
    expect(errorsOf(styled).join()).toMatch(/styling/);

    const foreign = clone();
    foreign.diagram.mermaid = 'flowchart LR\n  A[buildAuthRouter] --> B[redisCluster]';
    expect(errorsOf(foreign).join()).toMatch(/redisCluster/);
  });

  it('rejects prose', () => {
    expect(() => parseModelJson('Here is the replay you asked for.')).toThrow();
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

describe('grounding prunes ungrounded optional claims', () => {
  it('drops a config key posing as a dependency and an unearned diagram, and keeps the replay', async () => {
    const { groundReplay } = await import('../src/schema.js');
    const doc = clone();
    doc.dependencies.unshift({ name: 'buy.mint_sell.dump_fast_retry_eligible', change: 'used', evidence: 'package.json:11', why: 'A setting.' });
    doc.diagram.mermaid = 'flowchart LR\n  A[_run_fak_ladder] --> B[countAttempt]';
    const noChain = { ...ctx, facts: { ...ctx.facts, call_edges: ctx.facts.call_edges.slice(0, 2) } };
    const v = groundReplay(doc, noChain);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.replay.dependencies.map((d) => d.name)).toEqual(replay.dependencies.map((d) => d.name));
    expect(v.replay.diagram).toEqual({ title: '', mermaid: '' });
    expect(v.dropped.join()).toMatch(/dump_fast_retry_eligible/);
  });

  it('still fails on intent or sequence errors', async () => {
    const { groundReplay } = await import('../src/schema.js');
    const doc = clone();
    doc.sequence[0].files[0].path = 'src/nowhere.js';
    expect(groundReplay(doc, ctx).ok).toBe(false);
  });

  it('spells out the allowed sets in the prompt', async () => {
    const { limitsFor } = await import('../src/prompt.js');
    const text = limitsFor(r.facts);
    expect(text).toContain('express-rate-limit');
    expect(text).toContain('Diagram: allowed');
    expect(limitsFor({ ...r.facts, call_edges: [] })).toContain('Diagram: not allowed');
  });
});

describe('depth is a view', () => {
  it('keeps the most important steps in order', () => {
    expect(visibleSteps(replay.sequence, 'deep')).toHaveLength(6);
    expect(visibleSteps(replay.sequence, 'median')).toHaveLength(6);
    expect(visibleSteps(replay.sequence, 'shallow').map((s) => s.id)).toEqual(['s2', 's3', 's5']);
  });
});
