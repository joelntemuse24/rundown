import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/facts.js';
import { cacheKey } from '../src/generate.js';
import { PROMPT_VERSION, SCHEMA_TEXT, SYSTEM_PROMPT } from '../src/prompt.js';
import { SCHEMA_VERSION } from '../src/schema.js';

describe('cache key carries the prompt version', () => {
  it('derives the version from the prompt text, so an edit changes it', () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(PROMPT_VERSION).toBe(sha256(SYSTEM_PROMPT + SCHEMA_TEXT).slice(0, 8));
    const edited = sha256(SYSTEM_PROMPT + SCHEMA_TEXT + '\nOne more rule.').slice(0, 8);
    expect(edited).not.toBe(PROMPT_VERSION);
  });

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
