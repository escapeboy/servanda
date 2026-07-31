import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDuration, parseDuration } from '../src/duration.js';
import { BAND_OVERDUE, BAND_UNDATED, rank } from '../src/ranking.js';
import { makeFixture, type Fixture } from './support/fixture.js';

/**
 * §3.1 attention-market ranking and §4.1 duration arithmetic.
 *
 * "Undated commitments MUST NOT time-escalate; they rank by age × blocking." The band model
 * is how that MUST is made unconditional rather than merely usual.
 */

const NOW = new Date('2026-07-25T09:00:00Z');

describe('§3.1: undated items rank by age × blocking and never time-escalate', () => {
  it('an undated item stays in the undated band at any age', () => {
    for (const since of ['2026-07-24T09:00:00Z', '2016-07-25T09:00:00Z', '1970-01-01T00:00:00Z']) {
      expect(rank({ since, due: null, blocking_count: 0 }, NOW).band).toBe(BAND_UNDATED);
    }
  });

  it('a century-old undated item still ranks below a one-hour-overdue dated one', () => {
    const ancient = rank({ since: '1926-07-25T09:00:00Z', due: null, blocking_count: 9 }, NOW);
    const overdue = rank(
      { since: '2026-07-25T00:00:00Z', due: '2026-07-25T08:00:00Z', blocking_count: 0 },
      NOW,
    );
    expect(overdue.band).toBe(BAND_OVERDUE);
    expect(overdue.score).toBeGreaterThan(ancient.score);
  });

  it('within the undated band, age and blocking both raise the rank', () => {
    const base = rank({ since: '2026-07-20T09:00:00Z', due: null, blocking_count: 0 }, NOW);
    const older = rank({ since: '2026-07-01T09:00:00Z', due: null, blocking_count: 0 }, NOW);
    const blocking = rank({ since: '2026-07-20T09:00:00Z', due: null, blocking_count: 3 }, NOW);
    expect(older.score).toBeGreaterThan(base.score);
    expect(blocking.score).toBeGreaterThan(base.score);
  });

  it('a dated item beyond the horizon ages like an undated one rather than escalating early', () => {
    const farOff = rank(
      { since: '2026-07-20T09:00:00Z', due: '2027-07-20T09:00:00Z', blocking_count: 0 },
      NOW,
    );
    expect(farOff.band).toBe(BAND_UNDATED);
  });
});

describe('§4.1 ISO 8601 duration arithmetic', () => {
  it('parses the acceptance-window forms the spec uses', () => {
    expect(parseDuration('P5D')).toMatchObject({ days: 5 });
    expect(parseDuration('PT12H')).toMatchObject({ hours: 12 });
    expect(parseDuration('P1M')).toMatchObject({ months: 1 });
    expect(() => parseDuration('5 days')).toThrow();
    expect(() => parseDuration('P')).toThrow();
  });

  it('adds calendar months calendar-wise, not as 30 fixed days', () => {
    expect(addDuration(new Date('2026-01-31T00:00:00Z'), 'P1M').toISOString()).toBe(
      '2026-03-03T00:00:00.000Z',
    );
    expect(addDuration(new Date('2026-07-25T09:00:00Z'), 'P5D').toISOString()).toBe(
      '2026-07-30T09:00:00.000Z',
    );
  });
});

describe('brief: the attention market', () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = makeFixture({ now: new Date('2026-08-15T09:00:00.000Z') });
    fx.node.commit({
      intent: 'overdue and dated',
      owed_to: null,
      due: '2026-08-01T00:00:00Z',
      persona: null,
      propose: false,
    });
    fx.node.commit({ intent: 'undated', owed_to: null, due: null, persona: null, propose: false });
  });
  afterAll(() => fx.cleanup());

  it('puts the overdue dated item above the undated one', () => {
    const brief = fx.node.brief({ persona: null });
    expect(brief.slots[0]?.headline).toBe('overdue and dated');
    expect(brief.slots.map((s) => s.headline)).toContain('undated');
  });

  it('every slot names the persona whose pipeline produced it and carries an action', () => {
    for (const slot of fx.node.brief({ persona: null }).slots) {
      expect(slot.persona).toBe(fx.personas[0]);
      // M-21: the slot carries an act, never wording. `tool` may be null — an act v0 binds to
      // nothing is stated as such rather than pointed at a tool that would sign nothing.
      expect(slot.primary_action).not.toBeUndefined();
      if (slot.primary_action !== null) {
        expect(Object.keys(slot.primary_action).sort()).toEqual(['act', 'args', 'tool']);
      }
      expect(slot.item_id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('counts what fell below the line', () => {
    const brief = fx.node.brief({ persona: null });
    expect(brief.below_the_line_count).toBe(0);
    expect(brief.generated_at).toBe('2026-08-15T09:00:00.000Z');
  });
});
