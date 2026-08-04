import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARGON2ID_CONSTRAINED, derivePersona, withSignature } from '@servanda/crypto';
import type { DerivedPersona } from '@servanda/crypto';
import {
  dhKeyFrom,
  FederatedNode,
  GitTransport,
  HubClient,
  hubFetch,
  type FetchLike,
  type MemoryHub,
  type Transport,
} from '@servanda/federation';
import { ServandaNode } from '@servanda/node';
import { InboxRecord, PROTOCOL_VERSION } from '@servanda/types';
import { Vault } from '@servanda/vault';
import { seed, TestClock } from './support.js';

/**
 * Two people, two machines — the fixture the §5 stories run on.
 *
 * `support.ts`'s `freshInstall` gives one person one vault, which is everything scenarios 1–3
 * need. The stories here are about what the OTHER person sees at the same instant, so each side
 * gets its own vault directory, its own node and its own transport, and the only thing they share
 * is the medium. A shared vault would make every convergence assertion vacuous.
 *
 * One clock drives both sides. Two people do not disagree about the calendar in these stories —
 * they disagree about what has reached them — and a per-side clock would confuse the two.
 */

export interface Side {
  who: string;
  persona: DerivedPersona;
  vault: Vault;
  node: ServandaNode;
  fed: FederatedNode;
  transport: Transport;
  dir: string;
}

export interface TwoPeopleOptions {
  /** Build this side's transport. Defaults to a clone of one shared bare git repository. */
  transportFor?: (opts: {
    root: string;
    shared: string;
    who: string;
    personaId: string;
  }) => Transport | null;
  budgetFor?: (who: string) => ConstructorParameters<typeof FederatedNode>[0]['budget'];
}

export interface TwoPeople {
  root: string;
  shared: string;
  clock: TestClock;
  sides: Side[];
  cleanup(): void;
}

function makeSide(
  root: string,
  who: string,
  persona: DerivedPersona,
  clock: TestClock,
  transport: Transport,
  budget: ConstructorParameters<typeof FederatedNode>[0]['budget'],
): Side {
  const dir = join(root, `${who}-vault`);
  const vault = Vault.create({
    dir,
    passphrase: `${who}-passphrase-of-record`,
    kdf: ARGON2ID_CONSTRAINED,
    now: clock.now,
    author: { name: who, email: `${who}@servanda.test` },
  });
  vault.putPersona({
    persona_id: persona.personaId,
    persona_index: persona.personaIndex,
    label: who,
    scope_kind: 'personal',
    org_root: null,
    private_key: persona.privateKey,
    created_at: clock.iso(),
  });
  const node = new ServandaNode({
    vault,
    localStore: vault.localStore(`${dir}-state`),
    activePersona: persona.personaId,
    now: clock.now,
  });
  const fed = new FederatedNode({
    vault,
    persona: persona.personaId,
    transport,
    budget,
    verificationLevel: (counterparty) => node.verificationLevel(persona.personaId, counterparty),
    now: clock.now,
  });
  return { who, persona, vault, node, fed, transport, dir };
}

/**
 * Stand up N people, each on their own machine, sharing one git repository.
 *
 * `cast` is `[name, persona index]` pairs so a story reads as names rather than as
 * `derivePersona(seed, 3)`, which tells a reader nothing about who is owed what.
 */
export function twoPeople(
  cast: readonly (readonly [string, number])[],
  startInstant: string,
  opts: TwoPeopleOptions = {},
): TwoPeople {
  const root = mkdtempSync(join(tmpdir(), 'servanda-2p-'));
  const clock = new TestClock(new Date(startInstant));
  const shared = GitTransport.initShared(join(root, 'shared.git'));

  const sides = cast.map(([who, index]) => {
    const persona = derivePersona(seed, index);
    // `null` from `transportFor` means "this side stays on the shared repository" — which is how
    // a story puts one person on git and the other on a hub.
    const transport =
      opts.transportFor?.({ root, shared, who, personaId: persona.personaId }) ??
      GitTransport.init({ dir: join(root, `${who}-clone`), persona: persona.personaId, remote: shared });
    return makeSide(root, who, persona, clock, transport, opts.budgetFor?.(who));
  });

  return {
    root,
    shared,
    clock,
    sides,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** A hub-backed transport factory, for the stories where one side is not on the shared repo. */
export function hubTransport(opts: {
  hub: MemoryHub;
  baseUrl: string;
  persona: DerivedPersona;
  resolveDhKey: (persona: string) => string | null;
  now: () => Date;
  fetch?: FetchLike;
}): HubClient {
  return new HubClient({
    baseUrl: opts.baseUrl,
    persona: opts.persona.personaId,
    privateKey: opts.persona.privateKey,
    dhPrivateKey: opts.persona.dhPrivateKey,
    fetch: opts.fetch ?? hubFetch(opts.hub),
    resolveDhKey: opts.resolveDhKey,
    now: opts.now,
  });
}

/**
 * Resolve sealing keys the way a node must: from §6.7 inbox records that verify against the
 * persona they name (M-17). A bare map would skip exactly the check that makes a published key
 * trustworthy, and would pass while the production path was broken.
 */
export function dhDirectory(
  people: readonly DerivedPersona[],
  opts: { hubs?: string[]; issued_at?: string; now?: () => Date } = {},
): (recipient: string) => string | null {
  const issued_at = opts.issued_at ?? '2026-03-02T09:00:00Z';
  const records = new Map(
    people.map((p) => [
      p.personaId,
      InboxRecord.parse(
        withSignature(
          {
            v: PROTOCOL_VERSION,
            type: 'inbox' as const,
            persona: p.personaId,
            hubs: opts.hubs ?? ['https://hub.example'],
            dh_key: p.dhPublicKey,
            issued_at,
          },
          p.privateKey,
        ),
      ),
    ]),
  );
  const now = opts.now ?? (() => new Date(issued_at));
  return (recipient) => {
    const record = records.get(recipient);
    return record ? dhKeyFrom(record, now().toISOString()) : null;
  };
}

/**
 * A hub that can be switched off, so a story can say "the hub was down for a week".
 *
 * Refusing with HTTP 503 rather than throwing is the honest model of an outage: a client sees a
 * transport-layer refusal, which is precisely the case §6.7 tells senders to retry through.
 */
export function outageFetch(hub: MemoryHub, isDown: () => boolean): FetchLike {
  const live = hubFetch(hub);
  return async (url, init) => {
    if (isDown()) return { ok: false, status: 503, json: async () => ({ error: 'hub is down' }) };
    return live(url, init);
  };
}

/**
 * Push and pull in every direction until nothing new moves. §6.7's store-and-forward, wound up.
 *
 * One round is enough for one hop in each direction — every side pushes before any side pulls —
 * and rounds are expensive here (each is a git fetch/commit/push per side), so the default is the
 * number a story actually needs rather than a comfortable margin.
 */
export async function settle(people: TwoPeople, rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const side of people.sides) await side.fed.push();
    for (const side of people.sides) await side.fed.pull();
  }
}
