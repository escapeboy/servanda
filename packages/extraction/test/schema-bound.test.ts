import { describe, expect, it } from 'vitest';
import {
  createScriptedModelClient,
  createStubModelClient,
  EXTRACTION_JSON_SCHEMA,
  Extractor,
  parseExtractionResponse,
} from '../src/index.js';
import { envelope, PERSONA_A } from './fixtures.js';

describe('schema-bound output (§3.4)', () => {
  const valid = {
    envelope_id: 'e'.repeat(64),
    intent: 'send the contract',
    owner: 'local_user',
    owner_label: null,
    owed_to: 'none',
    owed_to_label: null,
    due: null,
    confidence: 0.7,
    quote: 'I will send the contract',
  };

  it('accepts a well-formed response', () => {
    const parsed = parseExtractionResponse(JSON.stringify({ results: [valid] }));
    expect(parsed.ok).toBe(true);
  });

  it('rejects prose, empty output, and half-JSON', () => {
    for (const text of ['', 'Here you go:', '{"results": [', 'null', '[]']) {
      expect(parseExtractionResponse(text).ok, text).toBe(false);
    }
  });

  it('rejects unknown fields — a model may not smuggle extra state through', () => {
    const parsed = parseExtractionResponse(
      JSON.stringify({ results: [{ ...valid, signature: 'deadbeef' }] }),
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects a label without the party ref that requires it, and vice versa', () => {
    expect(
      parseExtractionResponse(JSON.stringify({ results: [{ ...valid, owner_label: 'Ivan' }] })).ok,
    ).toBe(false);
    expect(
      parseExtractionResponse(
        JSON.stringify({ results: [{ ...valid, owner: 'other_party', owner_label: null }] }),
      ).ok,
    ).toBe(false);
  });

  it('rejects an out-of-range confidence and an over-long intent', () => {
    expect(parseExtractionResponse(JSON.stringify({ results: [{ ...valid, confidence: 1.5 }] })).ok).toBe(
      false,
    );
    expect(
      parseExtractionResponse(JSON.stringify({ results: [{ ...valid, intent: 'x'.repeat(501) }] })).ok,
    ).toBe(false);
  });

  it('drops a result whose `due` is not RFC 3339, discarding the batch rather than coercing it', async () => {
    const env = envelope('I will send the contract next Tuesday.', PERSONA_A);
    const model = createScriptedModelClient(
      JSON.stringify({ results: [{ ...valid, envelope_id: env.id, due: 'next Tuesday' }] }),
    );
    const run = await new Extractor({ persona: PERSONA_A, model }).extract([env]);
    expect(run.items).toHaveLength(0);
    expect(run.rejection?.stage).toBe('routing');
  });

  it('keeps the JSON schema inside the documented structured-outputs subset', () => {
    const seen = JSON.stringify(EXTRACTION_JSON_SCHEMA);
    for (const unsupported of ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf']) {
      expect(seen).not.toContain(unsupported);
    }
    const results = (EXTRACTION_JSON_SCHEMA['properties'] as Record<string, Record<string, unknown>>)[
      'results'
    ];
    const items = results?.['items'] as Record<string, unknown>;
    expect(items['additionalProperties']).toBe(false);
    expect(EXTRACTION_JSON_SCHEMA['additionalProperties']).toBe(false);
  });

  it('extracts nothing from an empty batch without calling the model', async () => {
    const run = await new Extractor({
      persona: PERSONA_A,
      model: createScriptedModelClient('this would be a parse error'),
    }).extract([]);
    expect(run.items).toHaveLength(0);
    expect(run.rejection).toBeUndefined();
  });
});

describe('stub model (deterministic dry-run path)', () => {
  it('produces the same output for the same input, every time', async () => {
    const env = envelope('I will send the contract by Friday.', PERSONA_A);
    const one = await new Extractor({ persona: PERSONA_A, model: createStubModelClient() }).extract([env]);
    const two = await new Extractor({ persona: PERSONA_A, model: createStubModelClient() }).extract([env]);
    expect(JSON.stringify(one.items)).toBe(JSON.stringify(two.items));
    expect(one.items.length).toBeGreaterThan(0);
  });

  it('reads a first-person undertaking and a reported one', async () => {
    const mine = envelope('I will send the contract by Friday.', PERSONA_A);
    const theirs = envelope('Ivan said he would review the migration.', PERSONA_A);
    const run = await new Extractor({ persona: PERSONA_A, model: createStubModelClient() }).extract([
      mine,
      theirs,
    ]);
    const dispositions = run.items.map((i) => i.routed.disposition).sort();
    expect(dispositions).toContain('reflexive');
    expect(dispositions).toContain('expectation-only');
  });

  it('resolves a stated deadline against the signal’s occurred_at', async () => {
    const env = envelope('I will send the contract by Friday.', PERSONA_A, '2026-07-01T10:00:00Z');
    const run = await new Extractor({ persona: PERSONA_A, model: createStubModelClient() }).extract([env]);
    const first = run.items[0];
    if (first === undefined) throw new Error('expected an extraction');
    if (first.routed.disposition === 'expectation-only') throw new Error('expected a commitment');
    // 2026-07-01 is a Wednesday; the next Friday is 2026-07-03.
    expect(first.routed.commitment.due).toBe('2026-07-03T23:59:59Z');
  });
});
