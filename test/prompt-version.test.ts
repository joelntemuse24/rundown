import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFacts, type Facts } from '../src/facts.js';
import { buildMessages, promptFingerprint, repairMessages, truncateDiff, truncationParts } from '../src/prompt.js';

const patch = readFileSync(new URL('../fixtures/sample.patch', import.meta.url), 'utf8');
const r = extractFacts({ diff: patch });
const diffText = truncateDiff(r.files, r.functionRanges).text;

/**
 * The parts PROMPT_VERSION is built from, rebuilt here independently of src/prompt.ts so the
 * coverage test proves something. Every render, the repair text, then the truncation constants.
 */
function partsFor(overrides: { budget?: number; big?: number; head?: number } = {}) {
  const empty: Facts = { ...r.facts, manifest_changes: [], imports_added: [], imports_removed: [], functions_touched: [], test_files: [], call_edges: [] };
  const noChain: Facts = { ...r.facts, call_edges: [] };
  const t = truncationParts();
  const render = (facts: Facts) => buildMessages(facts, diffText, { title: 'T', body: 'B', commits: ['c'] });
  return [
    ...render(r.facts).map((m) => `${m.role}:${m.content}`),
    ...render(empty).map((m) => `${m.role}:${m.content}`),
    ...render(noChain).map((m) => `${m.role}:${m.content}`),
    ...repairMessages(render(r.facts), 'prose', ['bad']).map((m) => `${m.role}:${m.content}`),
    String(overrides.budget ?? t.budget),
    String(overrides.big ?? t.largeFileLines),
    String(overrides.head ?? t.summaryHeadLines),
  ];
}

describe('PROMPT_VERSION covers the whole rendered prompt', () => {
  it('fingerprints every rendered prompt and all three truncation constants', () => {
    expect(promptFingerprint(partsFor())).toMatch(/^[0-9a-f]{8}$/);
    // Three rendered prompts at two messages each, a repair at four, and three constants.
    expect(partsFor()).toHaveLength(13);
  });

  it('covers every limitsFor branch: empty and non-empty sets, and both diagram cases', () => {
    const all = partsFor().join('\n');
    expect(all).toContain('none, so dependencies must be []');
    expect(all).toContain('none, so functions must be []');
    expect(all).toContain('none, so tests must be []');
    expect(all).toContain('express-rate-limit');
    expect(all).toContain('Diagram: allowed');
    expect(all).toContain('Diagram: not allowed');
  });

  it('covers the section labels and the repair text', () => {
    const all = partsFor().join('\n');
    for (const label of ['PR title:', 'PR body:', 'Commit subjects:', 'Unified diff:']) expect(all).toContain(label);
    expect(all).toContain('That reply was not JSON.');
  });

  it('changes when any rendered prompt changes', () => {
    const base = promptFingerprint(partsFor());
    for (let i = 0; i < 8; i++) {
      const edited = partsFor().map((p, j) => (i === j ? p + ' edited' : p));
      expect(promptFingerprint(edited)).not.toBe(base);
    }
  });

  it('changes with each truncation constant', () => {
    const base = promptFingerprint(partsFor());
    expect(promptFingerprint(partsFor({ budget: 1 }))).not.toBe(base);
    expect(promptFingerprint(partsFor({ big: 1 }))).not.toBe(base);
    expect(promptFingerprint(partsFor({ head: 1 }))).not.toBe(base);
  });
});
