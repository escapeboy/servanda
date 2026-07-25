import { describe, expect, it } from 'vitest';
import { createRecordingModelClient, Extractor, PersonaMixingError } from '../../src/index.js';
import { envelope, PERSONA_A, PERSONA_B } from '../fixtures.js';

/**
 * M-5: no org-context mixing in any pipeline. §2 binds a connector instance to exactly one
 * persona at registration; §3.4/§9.2 require extraction to run in a single-persona context.
 *
 * The binding is a constructor argument, so an extractor cannot be re-pointed mid-life, and the
 * check runs before anything is read from the batch — a mixed batch never reaches a model.
 */
describe('M-5: extraction runs in a single-persona context, bound at construction', () => {
  it('rejects an envelope belonging to another persona', async () => {
    const model = createRecordingModelClient();
    const extractor = new Extractor({ persona: PERSONA_A, model });

    await expect(extractor.extract([envelope('I will do it.', PERSONA_B)])).rejects.toThrow(
      PersonaMixingError,
    );
    expect(model.bodies, 'nothing may reach the model from a foreign persona').toHaveLength(0);
  });

  it('rejects the whole batch when personas are mixed, rather than filtering it', async () => {
    const model = createRecordingModelClient();
    const extractor = new Extractor({ persona: PERSONA_A, model });
    const batch = [
      envelope('I will send the invoice.', PERSONA_A),
      envelope('I will review the PR.', PERSONA_B),
      envelope('I will book the room.', PERSONA_A),
    ];

    await expect(extractor.extract(batch)).rejects.toThrow(PersonaMixingError);
    // Silently dropping the foreign envelope would leave the two same-persona ones extracted and
    // the mixing bug invisible. Nothing is extracted.
    expect(model.bodies).toHaveLength(0);
  });

  it('refuses to even build a request for a mixed batch', () => {
    const extractor = new Extractor({ persona: PERSONA_A, model: createRecordingModelClient() });
    expect(() =>
      extractor.buildRequest([
        envelope('I will send the invoice.', PERSONA_A),
        envelope('I will review the PR.', PERSONA_B),
      ]),
    ).toThrow(PersonaMixingError);
  });

  it('names both personas and the offending envelope, so a mixing bug is diagnosable', async () => {
    const offender = envelope('I will do it.', PERSONA_B);
    const extractor = new Extractor({
      persona: PERSONA_A,
      model: createRecordingModelClient(),
    });
    await expect(extractor.extract([offender])).rejects.toThrow(
      new RegExp(`${PERSONA_A}[\\s\\S]*${offender.id}[\\s\\S]*${PERSONA_B}`),
    );
  });

  it('binds the persona at construction and exposes no way to change it', async () => {
    const model = createRecordingModelClient();
    const extractor = new Extractor({ persona: PERSONA_A, model });
    expect(extractor.persona).toBe(PERSONA_A);
    // `persona` is a getter over a private field: assignment cannot take effect.
    expect(() => {
      (extractor as unknown as { persona: string }).persona = PERSONA_B;
    }).toThrow(TypeError);
    expect(extractor.persona).toBe(PERSONA_A);

    await extractor.extract([envelope('I will send the invoice.', PERSONA_A)]);
    expect(model.bodies).toHaveLength(1);
  });

  it('refuses a persona that is not a persona_id at all', () => {
    expect(() => new Extractor({ persona: 'not-a-key', model: createRecordingModelClient() })).toThrow(
      TypeError,
    );
  });
});
