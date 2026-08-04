import type { NodeClient } from '@servanda/client-web';

/**
 * The write half of the terminal, which did not exist.
 *
 * Every shipped surface could READ a register: the terminal draws it, the brief ranks it, the web
 * client renders it. Not one of them could put anything in it. `commit` had exactly three callers
 * — a library method, an MCP tool, and a gesture runner nothing calls — so the only way a person
 * could record a promise was through an assistant speaking MCP, or through the §3 capture path,
 * which needs a model and an API key.
 *
 * That is a product with no front door. §0's base rule is that L0–L1 works with no network, no
 * server and no second participant (M-10), and the implementation honoured it while offering no
 * way to exercise it: a person with no assistant wired up and no API key could create a vault and
 * then do nothing with it.
 *
 * These take a `NodeClient` rather than a node, so the same three verbs work against a local
 * vault today and a remote one later without this file changing.
 */

export interface ParsedCommand {
  readonly verb: 'commit' | 'expect' | 'done' | 'release';
  readonly text: string;
  readonly to: string | null;
  readonly due: string | null;
  readonly id: string | null;
  readonly propose: boolean;
}

export class UsageError extends Error {}

/**
 * `--due` accepts a date, not a duration, and refuses anything it cannot read.
 *
 * A promise whose date was silently misread is worse than one with no date: §4.3 escalates on
 * `due`, so a typo that parses as some other day moves when the other party may expire it.
 */
function parseDue(raw: string): string {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new UsageError(
      `not a date I can read: ${raw}\nUse an ISO date — 2026-08-11 or 2026-08-11T17:00:00Z.`,
    );
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export function parseArgs(argv: readonly string[]): ParsedCommand | null {
  const [verb, ...rest] = argv;
  if (verb !== 'commit' && verb !== 'expect' && verb !== 'done' && verb !== 'release') return null;

  const words: string[] = [];
  let to: string | null = null;
  let due: string | null = null;
  let propose = false;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--to') {
      to = rest[++i] ?? null;
      if (to === null) throw new UsageError('--to needs a name');
    } else if (a === '--due') {
      const v = rest[++i];
      if (v === undefined) throw new UsageError('--due needs a date');
      due = parseDue(v);
    } else if (a === '--propose') {
      propose = true;
    } else if (a.startsWith('--')) {
      throw new UsageError(`unknown option: ${a}`);
    } else {
      words.push(a);
    }
  }

  const text = words.join(' ').trim();
  if (verb === 'done' || verb === 'release') {
    if (text.length !== 64 || !/^[0-9a-f]{64}$/u.test(text)) {
      throw new UsageError(`${verb} takes the id of one promise, as shown in the register`);
    }
    return { verb, text: '', to: null, due: null, id: text, propose: false };
  }
  if (text.length === 0) throw new UsageError(`${verb} needs the words of the promise`);
  if (verb === 'expect' && to === null) {
    // §3.3: an expectation is about somebody else by definition. Without a `from` it is a note
    // to yourself, which is what `commit` already is.
    throw new UsageError('expect needs --to: whose promise are you waiting on?');
  }
  return { verb, text, to, due, id: null, propose };
}

export const USAGE = `servanda — your register of promises

  servanda                                  open the register
  servanda commit "<what you promised>" [--to <who>] [--due <date>] [--propose]
  servanda expect "<what you are waiting for>" --to <who>
  servanda done <id>                        you delivered it (needs evidence — see USAGE.md)
  servanda release <id>                     you are letting theirs go

  --propose sends it to them. Without it the promise stays on this machine, which is the
  whole of §0's base rule: this works with nobody else present.

Environment: SERVANDA_VAULT, SERVANDA_PASSPHRASE, optionally SERVANDA_PERSONA.`;

/**
 * Which persona in THIS vault a local label names, if any — supplied by the caller.
 *
 * A function rather than a list, and injected rather than imported, because this module must not
 * be able to open a vault: it composes what a person is told, and a module that can read the
 * store is a module whose wording can start depending on what is in it.
 */
export type LabelLookup = (label: string) => string | null;

export async function runCommand(
  cmd: ParsedCommand,
  client: NodeClient,
  labelLookup: LabelLookup = () => null,
): Promise<string> {
  switch (cmd.verb) {
    case 'commit': {
      const out = await client.commit({
        intent: cmd.text,
        owed_to: cmd.to,
        due: cmd.due,
        persona: null,
        propose: cmd.propose,
      });
      // The state is reported rather than assumed. `propose: true` with a counterparty this vault
      // cannot resolve stays vault-local (§3.1), and a person who asked to send it is owed that
      // sentence instead of silence.
      return out.state === 'proposed'
        ? `Recorded, and sent to ${cmd.to}.\n  ${out.edge_id}`
        : cmd.propose
          ? // NOT "cannot be reached", which is what this said first and which is false for the
            // commonest way to land here: a LOCAL LABEL of a persona in this very vault. §1.2
            // resolves labels for "who am I acting as" and never for "who is this owed to" —
            // `owed_to` on the wire is a persona_id or a §3.1 external_label, and a label is the
            // latter. Found by using it: `--to work --propose` reported that `work` was
            // unreachable while `work` sat in the same vault.
            //
            // The label is NOT resolved for them, deliberately, and this is the reason rather
            // than an omission: a label is the viewer's own word. Somebody who types `--to Boyan`
            // meaning the Boyan who is off-network, in a vault that happens to hold a persona
            // labelled `Boyan`, would have the promise silently redirected to themselves and put
            // on the wire. One typed word, two outcomes, and the dangerous one is the quiet one.
            // So the id is offered and the person chooses.
            localHint(cmd.to, labelLookup) + `Recorded here only.\n  ${out.commitment_hash}`
          : `Recorded.\n  ${out.commitment_hash}`;
    }
    case 'expect': {
      const out = await client.expect({ expect: cmd.text, from: cmd.to!, context: null });
      // §3.3 and ADR-0013: an expectation is yours, held locally, and never becomes their
      // promise. Said plainly, because "I noted it" and "they agreed" are different facts.
      return `Noted, for you only. It is not a promise they made.\n  ${out.expectation_id}`;
    }
    default: {
      const out = await client.act!({ id: cmd.id!, act: cmd.verb, evidence_hash: null });
      if (!out.accepted) {
        throw new UsageError(`Refused: ${out.rejection_reason ?? 'the register would not take it'}`);
      }
      return `Done — it is now ${out.asserts}.`;
    }
  }
}

/**
 * The sentence before "Recorded here only", which differs by what the vault knows.
 *
 * Two situations reach the same protocol outcome and are not the same thing to a person: a name
 * for somebody off-network (nothing is wrong, the record is local by design, §3.1) and a label
 * that happens to name one of your own personas (the id is one copy-paste away). Telling both of
 * them the same thing would be true and useless for one of them.
 */
function localHint(to: string | null, lookup: LabelLookup): string {
  if (to === null || to === '') return '';
  const id = lookup(to);
  if (id === null) {
    return (
      `"${to}" was taken as a name you wrote down, not as somebody to send to, so nothing left ` +
      `this machine. To send a promise you need the other party's persona id — 64 hex characters.\n`
    );
  }
  return (
    `"${to}" is one of YOUR personas in this vault, and a label is never read as who a promise ` +
    `is owed to — only as who you are acting as. That is on purpose: if you had meant somebody ` +
    `else of that name, resolving it would have quietly sent the promise to yourself.\n` +
    `If you did mean your own persona, say so with its id:\n  --to ${id}\n`
  );
}
