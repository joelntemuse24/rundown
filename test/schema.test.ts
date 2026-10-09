import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFacts } from '../src/facts.js';
import { parseModelJson } from '../src/generate.js';
import { presentReplay, visibleSteps, type Replay } from '../src/schema.js';

const fixtures = new URL('../fixtures/', import.meta.url);
const patch = readFileSync(new URL('sample.patch', fixtures), 'utf8');
const replay: Replay = JSON.parse(readFileSync(new URL('sample.replay.json', fixtures), 'utf8'));
const r = extractFacts({ diff: patch });

describe('fixture replay', () => {
  it('is shown unchanged', () => {
    const view = presentReplay(replay);
    expect(view.intentText).toBe(replay.intent.text);
    expect(view.steps.map((s) => s.summary)).toEqual(replay.sequence.map((s) => s.summary));
    expect(view.dependencies.map((d) => d.name)).toEqual(replay.dependencies.map((d) => d.name));
    expect(view.diagramMermaid).toBe(replay.diagram.mermaid);
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

describe('model JSON is stored as returned', () => {
  it('rejects prose and accepts a fenced object unchanged', () => {
    expect(() => parseModelJson('Here is the replay you asked for.')).toThrow();
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('shows a messy replay as-is and leaves missing fields empty', () => {
    const messy = {
      intent: { text: '  short  ', source: 'pr_body' },
      sequence: [
        { id: 's1', title: 'T', summary: 'x'.repeat(400), files: [{ path: 'src/nowhere.js', lines: 'nope' }], importance: 'critical' },
        'skip me',
      ],
      dependencies: [{ name: 'helmet', change: 'added', evidence: 'not a path:line', why: 'Security headers.' }],
      logic: [{ id: 'l1', step_id: 's1', summary: 'One. Two. Three.', evidence: 'see the middleware', failure_mode: '' }],
      diagram: { title: 'Nope', mermaid: 'this is not a diagram' },
    };
    const before = structuredClone(messy);
    const view = presentReplay(messy);
    expect(messy).toEqual(before);
    expect(view.intentText).toBe('  short  ');
    expect(view.intentSource).toBe('pr_body');
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0].summary).toHaveLength(400);
    expect(view.steps[0].files[0]).toEqual({ path: 'src/nowhere.js', lines: 'nope' });
    expect(view.dependencies[0]).toMatchObject({ name: 'helmet', evidence: 'not a path:line' });
    expect(view.logic[0].evidence).toBe('see the middleware');
    expect(view.diagramTitle).toBe('Nope');
    expect(view.diagramMermaid).toBe('this is not a diagram');
    expect(view.tests).toEqual([]);
    expect(view.functions).toEqual([]);
    expect(view.openQuestions).toEqual([]);

    const empty = presentReplay(null);
    expect(empty.intentText).toBe('');
    expect(empty.steps).toEqual([]);
    expect(empty.diagramMermaid).toBe('');
    expect(presentReplay({ intent: 'nope', sequence: [] }).steps).toEqual([]);
  });

  it('asks the model for path:line evidence, concise text, real names, and valid mermaid', async () => {
    const { SCHEMA_TEXT, SYSTEM_PROMPT, limitsFor } = await import('../src/prompt.js');
    const prompt = `${SYSTEM_PROMPT}\n${SCHEMA_TEXT}`;
    expect(prompt).toContain('path:line');
    expect(prompt).toContain('one or two sentences');
    expect(prompt).toContain('functions_touched');
    expect(prompt).toContain('valid Mermaid');
    expect(prompt).toContain('manifest_changes');
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
