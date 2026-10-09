import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize, parseDiff } from '../src/diff.js';
import { extractFacts, isTestFile } from '../src/facts.js';
import { hasChain } from '../src/schema.js';
import { truncateDiff } from '../src/prompt.js';

const patch = readFileSync(new URL('../fixtures/sample.patch', import.meta.url), 'utf8');
const expected = JSON.parse(readFileSync(new URL('../fixtures/sample.facts.json', import.meta.url), 'utf8'));

describe('facts', () => {
  it('matches the committed expected facts for the fixture', () => {
    expect(extractFacts({ diff: patch }).facts).toEqual(expected);
  });

  it('lists express-rate-limit and the test file', () => {
    const { facts } = extractFacts({ diff: patch });
    expect(facts.manifest_changes).toEqual([{ file: 'package.json', dependency: 'express-rate-limit', change: 'added', from: '', to: '^7.4.0' }]);
    expect(facts.test_files).toEqual(['test/loginLimiter.test.js']);
    expect(facts.commands_observed).toEqual([]);
  });

  it('finds a three-edge call chain only through the diff', () => {
    const { facts } = extractFacts({ diff: patch });
    expect(hasChain(facts.call_edges)).toBe(true);
    expect(hasChain(facts.call_edges.filter((e) => !e.from.endsWith(':buildAuthRouter')))).toBe(false);
  });

  it('hashes the same logical diff identically', () => {
    const a = extractFacts({ diff: patch }).facts.diff_hash;
    // Reorder files, add timestamps, and widen nothing: the canonical hash must not move.
    const blocks = patch.split(/(?=^diff --git )/m);
    const shuffled = [...blocks].reverse().join('').replace(/^(\+\+\+ b\/package\.json)$/m, '$1\t2024-05-01 10:00:00.000000000 +0000');
    expect(extractFacts({ diff: shuffled }).facts.diff_hash).toBe(a);
  });

  it('cuts context down to three lines', () => {
    const wide = [
      'diff --git a/x.py b/x.py',
      '--- a/x.py',
      '+++ b/x.py',
      '@@ -1,9 +1,9 @@',
      ' a', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', ' i',
      '',
    ].join('\n');
    const { text } = canonicalize(parseDiff(wide));
    expect(text).toContain('@@ -2,7 +2,7 @@');
    expect(text).not.toContain('\n a\n');
  });

  it('recognises test paths', () => {
    for (const p of ['test/a.js', 'pkg/tests/x.py', 'src/__tests__/a.ts', 'a.test.ts', 'b.spec.js', 'x_test.go', 'test_mod.py']) expect(isTestFile(p)).toBe(true);
    for (const p of ['src/testing.ts', 'contest/a.js', 'src/a.ts']) expect(isTestFile(p)).toBe(false);
  });

  it('reads Python, Go, and requirements changes', () => {
    const diff = [
      'diff --git a/requirements.txt b/requirements.txt',
      '--- a/requirements.txt',
      '+++ b/requirements.txt',
      '@@ -1,2 +1,2 @@',
      ' flask==3.0.0',
      '-requests==2.31.0',
      '+requests==2.32.0',
      'diff --git a/app/main.go b/app/main.go',
      '--- a/app/main.go',
      '+++ b/app/main.go',
      '@@ -1,3 +1,5 @@',
      ' package main',
      '+import "github.com/redis/go-redis/v9"',
      ' func main() {',
      '+\tconnect()',
      ' }',
      '',
    ].join('\n');
    const { facts } = extractFacts({ diff });
    expect(facts.manifest_changes).toEqual([{ file: 'requirements.txt', dependency: 'requests', change: 'bumped', from: '==2.31.0', to: '==2.32.0' }]);
    expect(facts.imports_added[0]).toMatchObject({ specifier: 'github.com/redis/go-redis/v9', kind: 'go', line: 2 });
    expect(facts.functions_touched).toEqual([{ path: 'app/main.go', name: 'main', line: 3, status: 'modified' }]);
  });

  it('follows self. method calls into a Python call chain', () => {
    const diff = [
      'diff --git a/bot/dump.py b/bot/dump.py',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/bot/dump.py',
      '@@ -0,0 +1,12 @@',
      '+class Dumper:',
      '+    def run(self):',
      '+        return self._run_fak_ladder()',
      '+',
      '+    def _run_fak_ladder(self):',
      '+        return self._run_dump_fak_with_refire()',
      '+',
      '+    def _run_dump_fak_with_refire(self):',
      '+        return self._send()',
      '+',
      '+    def _send(self):',
      '+        return None',
      '',
    ].join('\n');
    const { facts } = extractFacts({ diff });
    expect(facts.call_edges.map((e) => `${e.from.split(':')[1]}->${e.to.split(':')[1]}`)).toEqual([
      'run->_run_fak_ladder',
      '_run_fak_ladder->_run_dump_fak_with_refire',
      '_run_dump_fak_with_refire->_send',
    ]);
    expect(hasChain(facts.call_edges)).toBe(true);
  });

  it('truncates with manifests and tests first and marks the cut', () => {
    const r = extractFacts({ diff: patch });
    const out = truncateDiff(r.files, r.functionRanges, 1500);
    expect(out.indexOf('package.json')).toBeLessThan(out.indexOf('test/loginLimiter.test.js'));
    expect(out).toContain('[rundown: diff truncated');
  });
});

describe('python functions named only by a hunk header', () => {
  const diff = [
    'diff --git a/bot.py b/bot.py',
    '--- a/bot.py',
    '+++ b/bot.py',
    '@@ -40,6 +40,8 @@ def run_dump(leg, tol):',
    '     sold = 0.0',
    '     for _ in range(3):',
    '-        sold = ladder(leg)',
    '+        sold = _run_fak_ladder(leg)',
    '+        if not eligible(sold=sold, tol=tol):',
    '+            break',
    '     return sold',
    ' ',
    ' ',
    'diff --git a/tests/test_bot.py b/tests/test_bot.py',
    '--- a/tests/test_bot.py',
    '+++ b/tests/test_bot.py',
    '@@ -1,2 +1,3 @@',
    ' import unittest',
    '+from buy.mint_sell import eligible',
    ' ',
    '',
  ].join('\n');

  it('counts the enclosing function as modified once', () => {
    const { facts } = extractFacts({ diff });
    expect(facts.functions_touched).toContainEqual({ path: 'bot.py', name: 'run_dump', line: 42, status: 'modified' });
    expect(facts.functions_touched.filter((f) => f.name === 'run_dump')).toHaveLength(1);
    expect(facts.imports_added).toEqual([{ path: 'tests/test_bot.py', specifier: 'buy.mint_sell', line: 2, kind: 'py' }]);
  });
});
