import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/facts.js';
import { cacheKey } from '../src/generate.js';
import { PROMPT_VERSION, promptFingerprint } from '../src/prompt.js';
import { SCHEMA_VERSION } from '../src/schema.js';

describe('promptFingerprint', () => {
  it('is eight hex characters', () => {
    expect(promptFingerprint(['a', 'b'])).toMatch(/^[0-9a-f]{8}$/);
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives the same fingerprint for the same parts', () => {
    expect(promptFingerprint(['a', 'b'])).toBe(promptFingerprint(['a', 'b']));
  });

  it('changes when any single part changes', () => {
    const base = ['one', 'two', 'three'];
    for (let i = 0; i < base.length; i++) {
      const edited = base.map((x, j) => (i === j ? `${x}!` : x));
      expect(promptFingerprint(edited)).not.toBe(promptFingerprint(base));
    }
  });

  it('changes when a part is added, dropped, or reordered', () => {
    expect(promptFingerprint(['a', 'b'])).not.toBe(promptFingerprint(['a', 'b', 'c']));
    expect(promptFingerprint(['a', 'b'])).not.toBe(promptFingerprint(['a']));
    expect(promptFingerprint(['a', 'b'])).not.toBe(promptFingerprint(['b', 'a']));
  });

  it('does not collide when a part boundary moves', () => {
    // Length-prefixed parts, so "ab"+"c" and "a"+"bc" stay distinct.
    expect(promptFingerprint(['ab', 'c'])).not.toBe(promptFingerprint(['a', 'bc']));
  });
});

describe('cache key carries the prompt version', () => {
  it('hashes diff hash, schema version, prompt version, model and extra', () => {
    expect(cacheKey('abc', 'mock')).toBe(sha256(`abc:${SCHEMA_VERSION}:${PROMPT_VERSION}:mock:`));
    expect(cacheKey('abc', 'mock', 'rec1')).toBe(sha256(`abc:${SCHEMA_VERSION}:${PROMPT_VERSION}:mock:rec1`));
    // The pre-0.2 key, diff hash + schema version + model, must not be reused.
    expect(cacheKey('abc', 'mock')).not.toBe(sha256(`abc:${SCHEMA_VERSION}:mock`));
  });

  it('separates one recording from the same diff without one', () => {
    expect(cacheKey('abc', 'mock')).not.toBe(cacheKey('abc', 'mock', 'rec1'));
    expect(cacheKey('abc', 'mock', 'rec1')).not.toBe(cacheKey('abc', 'mock', 'rec2'));
  });
});
