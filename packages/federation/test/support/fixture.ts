import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePersona, mnemonicToSeed, withSignature } from '@servanda/crypto';
import type { DerivedPersona } from '@servanda/crypto';
import { ServandaNode } from '@servanda/node';
import { PROTOCOL_VERSION, InboxRecord } from '@servanda/types';
import { Vault, type PersonaRecord } from '@servanda/vault';
import { dhKeyFrom } from '../../src/addressing.js';
import { FederatedNode } from '../../src/federated-node.js';
import { GitTransport } from '../../src/git-transport.js';
import type { ProposalBudget } from '../../src/antispam.js';
import { Inbox } from '../../src/inbox.js';
import type { Transport } from '../../src/transport.js';

/**
 * Federation fixtures. The point of this file is that each peer gets its OWN vault directory
 * and its OWN working clone — nothing is shared except the transport medium. A single-vault
 * fixture (as L1's tests correctly use) can prove the transition table; only two vaults can
 * prove that two machines converge, which is what §6 exists for.
 *
 * Keys come from the published BIP-39 test mnemonic the conformance vectors use, so persona 0
 * and persona 1 are the same keys as the transition vectors' owner and owed_to.
 */

export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';

export const TEST_PASSPHRASE = 'correct horse battery staple';

const seed = mnemonicToSeed(TEST_MNEMONIC);

/**
 * A §6.7 inbox record for a persona, signed by it, carrying its X25519 key.
 *
 * Tests resolve sealing keys through this rather than through a bare map, because the map would
 * skip the only thing that makes a published key trustworthy: M-17's rule that a record verifies
 * against the persona it names. A fixture that hands out keys directly would pass while the
 * production path was broken.
 */
export function inboxRecordFor(
  p: { personaId: string; privateKey: string; dhPublicKey: string },
  opts: { hubs?: string[]; issued_at?: string } = {},
): InboxRecord {
  return InboxRecord.parse(
    withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'inbox' as const,
        persona: p.personaId,
        hubs: opts.hubs ?? ['https://hub.example'],
        dh_key: p.dhPublicKey,
        issued_at: opts.issued_at ?? '2026-07-25T09:00:00Z',
      },
      p.privateKey,
    ),
  );
}

/** Resolve a sealing key the way a node would: from signed records, at a fixed instant. */
export function dhDirectory(
  people: readonly { personaId: string; privateKey: string; dhPublicKey: string }[],
  now = '2026-07-25T09:00:00Z',
): (recipient: string) => string | null {
  const records = new Map(people.map((p) => [p.personaId, inboxRecordFor(p)]));
  return (recipient) => {
    const record = records.get(recipient);
    return record ? dhKeyFrom(record, now) : null;
  };
}

export function persona(index: number): DerivedPersona {
  return derivePersona(seed, index);
}

export interface Peer {
  index: number;
  personaId: string;
  privateKey: string;
  dir: string;
  vault: Vault;
  node: ServandaNode;
  transport: Transport;
  fed: FederatedNode;
}

export interface Pair {
  root: string;
  shared: string;
  a: Peer;
  b: Peer;
  now: Date;
  setNow(d: Date): void;
  cleanup(): void;
}

export interface PairOptions {
  now?: Date;
  budgetFor?: { a?: ProposalBudget; b?: ProposalBudget };
  /** Build a transport for a peer. Defaults to a git clone of the shared bare repository. */
  transportFor?: (opts: { root: string; shared: string; label: string; personaId: string }) => Transport;
}

function makePeer(
  root: string,
  label: string,
  index: number,
  clock: () => Date,
  transport: Transport,
  budget: ProposalBudget | undefined,
): Peer {
  const derived = persona(index);
  const dir = join(root, `${label}-vault`);
  const vault = Vault.create({ dir, passphrase: TEST_PASSPHRASE, now: clock });
  const record: PersonaRecord = {
    persona_id: derived.personaId,
    persona_index: index,
    label,
    scope_kind: 'personal',
    org_root: null,
    private_key: derived.privateKey,
    created_at: clock().toISOString(),
  };
  vault.putPersona(record);
  const node = new ServandaNode({ vault, activePersona: derived.personaId, now: clock });
  const fed = new FederatedNode({
    vault,
    persona: derived.personaId,
    transport,
    budget,
    verificationLevel: (counterparty) => node.verificationLevel(derived.personaId, counterparty),
    now: clock,
  });
  return { index, personaId: derived.personaId, privateKey: derived.privateKey, dir, vault, node, transport, fed };
}

/** Two nodes, two vaults, two clones of one local bare repository. No network anywhere. */
export function makePair(opts: PairOptions = {}): Pair {
  const root = mkdtempSync(join(tmpdir(), 'servanda-fed-'));
  let now = opts.now ?? new Date('2026-07-25T09:00:00.000Z');
  const clock = () => now;

  const shared = GitTransport.initShared(join(root, 'shared.git'));
  const build = (label: string, personaId: string): Transport =>
    opts.transportFor
      ? opts.transportFor({ root, shared, label, personaId })
      : GitTransport.init({ dir: join(root, `${label}-clone`), persona: personaId, remote: shared });

  const aId = persona(0).personaId;
  const bId = persona(1).personaId;

  const a = makePeer(root, 'a', 0, clock, build('a', aId), opts.budgetFor?.a);
  const b = makePeer(root, 'b', 1, clock, build('b', bId), opts.budgetFor?.b);

  return {
    root,
    shared,
    a,
    b,
    get now() {
      return now;
    },
    setNow(d: Date) {
      now = d;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

export interface Solo {
  personaId: string;
  privateKey: string;
  vault: Vault;
  inbox: Inbox;
  cleanup(): void;
}

/**
 * One vault and one inbox, with no transport at all — for asserting what the inbox does with a
 * given wire message. The wire is the input under test; how it arrived is not.
 */
export function makeSolo(index = 0, opts: { now?: Date; budget?: ProposalBudget } = {}): Solo {
  const derived = persona(index);
  const dir = mkdtempSync(join(tmpdir(), 'servanda-fed-solo-'));
  const clock = () => opts.now ?? new Date('2026-07-25T09:00:00.000Z');
  const vault = Vault.create({ dir, passphrase: TEST_PASSPHRASE, now: clock });
  vault.putPersona({
    persona_id: derived.personaId,
    persona_index: index,
    label: `p${index}`,
    scope_kind: 'personal',
    org_root: null,
    private_key: derived.privateKey,
    created_at: clock().toISOString(),
  });
  return {
    personaId: derived.personaId,
    privateKey: derived.privateKey,
    vault,
    inbox: new Inbox({ vault, persona: derived.personaId, budget: opts.budget }),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/**
 * Wipe one edge's subtree so the next case starts from an empty chain.
 *
 * A fixture-only escape hatch: the vault deliberately offers no delete (§4.2 chains are
 * append-only), and creating a fresh vault per case costs a passphrase KDF each time. Reaching
 * past the API is acceptable here precisely because nothing under test depends on it.
 */
export function forgetEdge(solo: Solo, edgeId: string): void {
  rmSync(join(solo.vault.dir, 'personas', solo.personaId, 'edges', edgeId), {
    recursive: true,
    force: true,
  });
}

/** Deliver in both directions until nothing new moves. §6.7's store-and-forward, wound up. */
export async function settle(pair: Pair, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await pair.a.fed.push();
    await pair.b.fed.push();
    await pair.a.fed.pull();
    await pair.b.fed.pull();
  }
}
