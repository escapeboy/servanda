import { describe, expect, it } from 'vitest';
import type { NodeClient } from '@servanda/client-web';
import { USAGE, UsageError, parseArgs, runCommand } from '../src/write-commands.js';

/**
 * The write half, which did not exist until now.
 *
 * Everything shipped could READ a register — the terminal draws it, the brief ranks it, the web
 * client renders it — and nothing could put a promise in one. `commit` had three callers: a
 * library method, an MCP tool, and a gesture runner nothing calls. So recording a promise
 * required an assistant speaking MCP or a model API key, and §0's base rule — works with no
 * network, no server, no second participant — was true of the protocol and unreachable by a
 * person.
 */
describe('what the words mean before anything is signed', () => {
  it('is not a command at all when the first word is not one', () => {
    // `servanda` with no verb opens the register; `--ink` is a render flag. Returning null rather
    // than throwing is what keeps those working.
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['--ink'])).toBeNull();
  });

  it('takes the promise as words, not as a quoted blob it has to unpick', () => {
    const cmd = parseArgs(['commit', 'Send', 'Maria', 'the', 'quote'])!;
    expect(cmd.verb).toBe('commit');
    expect(cmd.text).toBe('Send Maria the quote');
    // Local unless asked otherwise. §0's base rule is the default, not the fallback.
    expect(cmd.propose).toBe(false);
    expect(cmd.to).toBeNull();
  });

  it('refuses a date it cannot read rather than guessing at one', () => {
    // §4.3 escalates on `due`: a typo that parsed as some other day would move when the other
    // party may expire the promise. Silence is not available here.
    expect(() => parseArgs(['commit', 'x', '--due', 'next tuesday'])).toThrow(UsageError);
    expect(parseArgs(['commit', 'x', '--due', '2026-08-11'])!.due).toBe('2026-08-11T00:00:00Z');
  });

  it('refuses an expectation with nobody to expect it from', () => {
    // §3.3: an expectation is about somebody else by definition. Without a name it is a note to
    // yourself, which is what `commit` already is.
    expect(() => parseArgs(['expect', 'their draft'])).toThrow(/whose promise/u);
  });

  it('and refuses an unknown option instead of ignoring it', () => {
    // An ignored flag is a person believing they asked for something they did not get.
    expect(() => parseArgs(['commit', 'x', '--send'])).toThrow(/unknown option/u);
  });

  it('takes an id for the acts that sign, and only a well-formed one', () => {
    expect(() => parseArgs(['done', 'the quote thing'])).toThrow(/id of one promise/u);
    // §4.3: `done` is the owner saying they delivered and MUST carry evidence — that is what
    // separates a closure from an assertion. Refusing here rather than at the node means the
    // person is told what to add instead of being told the register would not take it.
    expect(() => parseArgs(['done', 'a'.repeat(64)])).toThrow(/--evidence/u);
    const cmd = parseArgs(['done', 'a'.repeat(64), '--evidence', 'plan.md, 14 pages'])!;
    expect(cmd.id).toBe('a'.repeat(64));
    expect(cmd.evidence).toBe('plan.md, 14 pages');
    // …and `release` MUST NOT: giving up a claim is not evidencing delivery.
    expect(() => parseArgs(['release', 'a'.repeat(64), '--evidence', 'x'])).toThrow(/no --evidence/u);
  });

  it('the usage text names every verb it accepts', () => {
    for (const verb of ['commit', 'expect', 'done', 'release']) {
      expect(USAGE).toContain(`servanda ${verb}`);
    }
  });
});

/** A stand-in that records what was asked of it and answers as §7 says a node answers. */
function client(over: Partial<NodeClient> = {}): NodeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async commit(input) {
      calls.push(`commit:${input.intent}:${String(input.propose)}`);
      return input.propose
        ? { commitment_hash: 'c'.repeat(64), edge_id: 'e'.repeat(64), state: 'proposed' }
        : { commitment_hash: 'c'.repeat(64), edge_id: null, state: 'vault-local' };
    },
    async expect(input) {
      calls.push(`expect:${input.expect}:${input.from}`);
      return { expectation_id: 'x'.repeat(64) };
    },
    async confirm() {
      throw new Error('not used');
    },
    async open_loops() {
      throw new Error('not used');
    },
    async brief() {
      throw new Error('not used');
    },
    ...over,
  } as NodeClient & { calls: string[] };
}

describe('what a person is told back', () => {
  it('says it was recorded here, when that is what happened', async () => {
    const c = client();
    const out = await runCommand(parseArgs(['commit', 'a promise'])!, c);
    expect(out).toMatch(/^Recorded\./u);
    expect(c.calls).toEqual(['commit:a promise:false']);
  });

  it('and names the person when it actually went to them', async () => {
    const c = client();
    const out = await runCommand(parseArgs(['commit', 'a promise', '--to', 'Boyan', '--propose'])!, c);
    expect(out).toContain('sent to Boyan');
  });

  it('and says it did NOT when the name could not be reached', async () => {
    // §3.1: `propose:true` with an unresolvable counterparty stays vault-local. A person who
    // asked to send it is owed that sentence — the old failure mode is reporting success for a
    // promise that never left.
    const c = client({
      async commit() {
        return { commitment_hash: 'c'.repeat(64), edge_id: null, state: 'vault-local' };
      },
    });
    const out = await runCommand(parseArgs(['commit', 'a promise', '--to', 'nobody@example.com', '--propose'])!, c);
    // The message must not claim the name is unreachable: a LABEL of a persona in this very
    // vault lands here too, because §1.2 resolves labels for "who am I acting as" and never for
    // "who is this owed to" — `owed_to` on the wire is a persona_id or a §3.1 external_label.
    // Observed by using it: `--to work --propose` said "work is not someone this vault can
    // reach" about a persona sitting in that vault.
    expect(out).toMatch(/taken as a name you wrote down/u);
    expect(out).toMatch(/persona id/u);
    expect(out).not.toMatch(/sent to/u);
  });

  it('and when the name IS one of your own personas, says so and hands over the id', async () => {
    // The same protocol outcome, a different situation, and one message for both would be true
    // and useless for one of them. The label is still NOT resolved: somebody who typed a name
    // meaning an off-network person, in a vault holding a persona of that name, would otherwise
    // have the promise silently redirected to themselves and put on the wire.
    const c = client({
      async commit() {
        return { commitment_hash: 'c'.repeat(64), edge_id: null, state: 'vault-local' };
      },
    });
    const id = 'd'.repeat(64);
    const out = await runCommand(
      parseArgs(['commit', 'a promise', '--to', 'work', '--propose'])!,
      c,
      (label) => (label === 'work' ? id : null),
    );
    expect(out).toMatch(/one of YOUR personas/u);
    expect(out).toContain(`--to ${id}`);
    // Still not sent, and still not resolved for them.
    expect(out).not.toMatch(/sent to/u);
  });

  it('says an expectation is yours and not their promise', async () => {
    // M-1 in one sentence, at the moment it matters. "They said they would" is not a promise
    // they made, and a register that blurred the two would be worse than no register.
    const c = client();
    const out = await runCommand(parseArgs(['expect', 'their draft', '--to', 'Ana'])!, c);
    expect(out).toMatch(/not a promise they made/u);
    expect(c.calls).toEqual(['expect:their draft:Ana']);
  });

  it('surfaces a refusal from `act` as a refusal, not as success', async () => {
    const c = client({
      async act() {
        return { accepted: false, rejection_reason: 'wrong-role-for-act', asserts: null };
      },
    } as Partial<NodeClient>);
    await expect(
      runCommand(parseArgs(['done', 'a'.repeat(64), '--evidence', 'delivered'])!, c),
    ).rejects.toThrow(/wrong-role-for-act/u);
  });
});
