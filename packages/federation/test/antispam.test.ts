import { describe, expect, it } from 'vitest';
import * as federation from '../src/index.js';
import { BulkInviteRefused, ProposalBudget, assertUserInitiatedConversion } from '../src/antispam.js';
import { persona } from './support/fixture.js';

/**
 * §6.5 anti-spam / proposal budget. "A `proposed` edge is socially nothing (Sybil rule)."
 */

const A = persona(0).personaId;
const B = persona(1).personaId;
let clock = new Date('2026-07-25T09:00:00Z');

describe('§6.5 proposal budget', () => {
  it('MUST NOT surface level-0 proposals above the client-configured cap', () => {
    const budget = new ProposalBudget({ levelZeroCap: 2, perUnknownSenderLimit: 99 });
    expect(budget.admit(A, '0')).toEqual({ surface: true });
    expect(budget.admit(B, '0')).toEqual({ surface: true });
    expect(budget.admit(persona(2).personaId, '0')).toEqual({
      surface: false,
      reason: 'level-0-cap-reached',
    });
    expect(budget.spent()).toEqual({ levelZeroSurfaced: 2, levelZeroCap: 2 });
  });

  it('the cap is the client’s to choose — there is no library default', () => {
    // @ts-expect-error the option is required on purpose
    expect(() => new ProposalBudget({})).toThrow(RangeError);
    expect(() => new ProposalBudget({ levelZeroCap: -1 })).toThrow(RangeError);
  });

  it('rate-limits per unknown sender within the window, and forgets after it', () => {
    const budget = new ProposalBudget({
      levelZeroCap: 100,
      perUnknownSenderLimit: 2,
      windowMs: 1000,
      now: () => clock,
    });
    expect(budget.admit(A, '0').surface).toBe(true);
    expect(budget.admit(A, '0').surface).toBe(true);
    expect(budget.admit(A, '0')).toEqual({ surface: false, reason: 'rate-limited' });
    // A different sender is unaffected: the limit is per sender, not global.
    expect(budget.admit(B, '0').surface).toBe(true);

    clock = new Date('2026-07-25T09:00:02Z');
    expect(budget.admit(A, '0').surface).toBe(true);
  });

  it('a known counterparty is never rate-limited — the Sybil rule is about strangers', () => {
    const budget = new ProposalBudget({ levelZeroCap: 0, perUnknownSenderLimit: 0 });
    for (let i = 0; i < 10; i++) expect(budget.admit(A, '1')).toEqual({ surface: true });
    expect(budget.admit(A, '0')).toEqual({ surface: false, reason: 'rate-limited' });
  });

  it('a suppressed proposal does not consume the cap it was refused by', () => {
    const budget = new ProposalBudget({ levelZeroCap: 1, perUnknownSenderLimit: 1 });
    expect(budget.admit(A, '0').surface).toBe(true);
    expect(budget.admit(A, '0').surface).toBe(false);
    expect(budget.admit(A, '0').surface).toBe(false);
    expect(budget.spent().levelZeroSurfaced).toBe(1);
  });
});

describe('§6.5 expectation→proposal conversion is user-initiated per counterparty', () => {
  it('refuses a conversion that no user asked for', () => {
    expect(() =>
      assertUserInitiatedConversion({ expectation_id: 'abc', counterparty: A, user_initiated: false }),
    ).toThrow(BulkInviteRefused);
  });

  it('accepts exactly one counterparty, explicitly', () => {
    expect(() =>
      assertUserInitiatedConversion({ expectation_id: 'abc', counterparty: A, user_initiated: true }),
    ).not.toThrow();
    expect(() =>
      assertUserInitiatedConversion({ expectation_id: 'abc', counterparty: 'everyone', user_initiated: true }),
    ).toThrow(BulkInviteRefused);
  });

  it('no bulk form exists anywhere in this package', () => {
    // "No bulk auto-invites" is enforced by absence, so the absence is what is asserted: no
    // exported name suggests one, and every export is a single-counterparty operation.
    const names = Object.keys(federation).filter((n) => n !== 'BulkInviteRefused');
    expect(names.filter((n) => /bulk|broadcast|invite[Aa]ll|massInvite/i.test(n))).toEqual([]);
    expect(names).toContain('assertUserInitiatedConversion');
    // `BulkInviteRefused` is the refusal, not a capability — it is the only name in the package
    // that mentions bulk anything, and it exists to make the refusal nameable at a call site.
    expect(federation.BulkInviteRefused.prototype).toBeInstanceOf(Error);
  });
});
