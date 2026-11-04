import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caseFromDiff, formatSummary, parseFirstReply, scoreReply, summarise } from '../eval/score.js';
import { extractFacts } from '../src/facts.js';

const patch = readFileSync(new URL('../fixtures/sample.patch', import.meta.url), 'utf8');
const replay = JSON.parse(readFileSync(new URL('../fixtures/sample.replay.json', import.meta.url), 'utf8'));
const r = extractFacts({ diff: patch });
const c = caseFromDiff('sample', patch, r.facts);
const tokens = { prompt: 100, completion: 50 };

describe('eval scorer', () => {
  it('scores the committed replay as clean', () => {
    const s = scoreReply(c, replay, tokens, false);
    expect(s.parsedFirst).toBe(true);
    expect(s.evidenceTotal).toBeGreaterThan(0);
    expect(s.evidenceInDiff).toBe(s.evidenceTotal);
    expect(s.allowedNamesOk).toBe(true);
    expect(s.stepCountOk).toBe(true);
    expect(s.criticalOk).toBe(true);
    expect(s.logicStepIdsOk).toBe(true);
    expect(s.diagramOk).toBe(true);
    expect(s.buildsOnOk).toBe(true);
    const summary = summarise([s]);
    expect(summary.evidenceShare).toBe(1);
    expect(summary.allowedShare).toBe(1);
    expect(summary.shapeShare).toBe(1);
    expect(formatSummary(summary, [s])).toContain('1 cases');
  });

  it('counts evidence outside the diff and names invented symbols', () => {
    const bad = {
      ...replay,
      dependencies: [...replay.dependencies, { name: 'helmet', change: 'added', evidence: 'package.json:900', why: 'Headers.' }],
      logic: [...replay.logic, { id: 'l9', step_id: 'nope', summary: 'x', evidence: 'src/nowhere.js:3', failure_mode: '' }],
      functions: [...replay.functions, { path: 'src/x.js', name: 'invented', note: 'n', evidence: 'src/x.js:1' }],
      tests: [...replay.tests, { file: 'test/other.test.js', locks: 'l', does_not_cover: 'd', evidence: 'test/other.test.js:1' }],
    };
    const s = scoreReply(c, bad, tokens, false);
    expect(s.evidenceInDiff).toBeLessThan(s.evidenceTotal);
    expect(s.allowedNamesOk).toBe(false);
    expect(s.badNames).toContain('dependency helmet');
    expect(s.badNames).toContain('function src/x.js:invented');
    expect(s.badNames).toContain('test test/other.test.js');
    expect(s.logicStepIdsOk).toBe(false);
    const summary = summarise([scoreReply(c, replay, tokens, false), s]);
    expect(summary.evidenceShare).toBeLessThan(1);
    expect(summary.allowedShare).toBe(0.5);
  });

  it('counts shape: step count, critical steps, and a diagram only when allowed', () => {
    const noChain = { ...r.facts, call_edges: [] };
    const c2 = caseFromDiff('no-chain', patch, noChain);
    const withDiagram = scoreReply(c2, replay, tokens, false);
    expect(withDiagram.diagramOk).toBe(false);

    const short = { ...replay, sequence: [replay.sequence[0]], logic: [] };
    const s = scoreReply(c, short, tokens, false);
    expect(s.stepCountOk).toBe(false);

    const manyCritical = { ...replay, sequence: replay.sequence.map((x: any) => ({ ...x, importance: 'critical' })) };
    expect(scoreReply(c, manyCritical, tokens, false).criticalOk).toBe(false);
  });

  it('checks builds_on once the model writes it', () => {
    const seq = replay.sequence.map((x: any, i: number) => ({ ...x, builds_on: i === 0 ? [] : [replay.sequence[i - 1].id] }));
    expect(scoreReply(c, { ...replay, sequence: seq }, tokens, false).buildsOnOk).toBe(true);
    const forward = { ...replay, sequence: [{ ...replay.sequence[0], builds_on: ['s2'] }, ...replay.sequence.slice(1)] };
    expect(scoreReply(c, forward, tokens, false).buildsOnOk).toBe(false);
    const unknown = { ...replay, sequence: [{ ...replay.sequence[0], builds_on: ['nope'] }, ...replay.sequence.slice(1)] };
    expect(scoreReply(c, unknown, tokens, false).buildsOnOk).toBe(false);
  });

  it('reads a fenced reply as JSON and prose as a repair case', () => {
    expect(parseFirstReply('```json\n{"a":1}\n```').ok).toBe(true);
    expect(parseFirstReply('Sure! Here is the replay.').ok).toBe(false);
    const prose = scoreReply(c, {}, tokens, true);
    expect(prose.parsedFirst).toBe(false);
    expect(prose.parsedAfterRepair).toBe(true);
  });
});
