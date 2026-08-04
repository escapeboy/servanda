import { COPY } from './copy.js';

/**
 * Things the node knows and no surface said.
 *
 * Each of these existed as a value somewhere and reached nobody: `Vault.kdfProfile()` reported
 * `behindDefault` with exactly one caller — itself — and `OutboundStatus` carried a whole
 * sentence about undeliverable messages inside `@servanda/federation`, which no shipped client
 * imports. A fact with no surface is indistinguishable from an absent fact.
 *
 * **Everything here takes FACTS and writes the words locally.** `@servanda/federation` already
 * composes an `explanation` string, and rendering that verbatim would be node-authored copy
 * crossing into a client, which is what M-21 forbids and what gate GE scans for. The reason is
 * not tidiness: the wording is the part that decides whether somebody stops trusting a promise
 * or stops changing their password, and it belongs to the surface that knows who is reading.
 *
 * It is also why `client-web` depends on `@servanda/types` and nothing else. Neither
 * `@servanda/crypto` nor `@servanda/federation` can be imported here — one carries a KDF, the
 * other git and HTTP transports — so an embedder maps their values onto these inputs.
 */

export interface KdfProfile {
  readonly m: number;
  readonly t: number;
  readonly p: number;
}

export interface VaultStrengthInput {
  /** What this vault's keys were actually wrapped at, or null when it cannot be read. */
  readonly profile: KdfProfile | null;
  /** What this build would wrap at today. */
  readonly current: KdfProfile;
  /**
   * The command that raises it, verbatim.
   *
   * A command is DATA, not wording — it is a literal string the person types — so passing it in
   * does not put copy across the boundary. Telling somebody their vault is weak without telling
   * them what to run is worse than silence, which is the state this was in: `rewrapPassphrase`
   * and `upgradeKdf` both existed and no command reached either.
   */
  readonly command: string;
}

export interface VaultStrengthView {
  readonly weak: boolean;
  /** How much less memory a guess costs against this vault than against one made today. */
  readonly memoryFactor: number;
  readonly workFactor: number;
  readonly heading: string | null;
  readonly reassurance: string | null;
  readonly line: string | null;
  readonly command: string | null;
}

const NOT_WEAK: VaultStrengthView = {
  weak: false,
  memoryFactor: 1,
  workFactor: 1,
  heading: null,
  reassurance: null,
  line: null,
  command: null,
};

export function buildVaultStrength(input: VaultStrengthInput | undefined): VaultStrengthView {
  if (input === undefined || input.profile === null) return NOT_WEAK;
  const { profile, current } = input;
  const work = profile.m * profile.t * profile.p;
  const currentWork = current.m * current.t * current.p;
  if (work >= currentWork) return NOT_WEAK;

  // Memory and work are reported apart because they buy different things: memory decides how
  // many guesses fit on one GPU at once, and it is the larger factor of the two.
  const memoryFactor = Math.round(current.m / profile.m);
  const workFactor = Math.round(currentWork / work);
  return {
    weak: true,
    memoryFactor,
    workFactor,
    heading: COPY.strength.heading,
    // Said BEFORE the numbers, and not optional. A warning that reads like a breach gets a vault
    // deleted by somebody trying to be safe, and there is nothing to be safe from here: no key
    // left, nothing was read, the promises are intact. The only thing that is true is that
    // guessing the passphrase is cheaper than it would be for a vault made today.
    reassurance: COPY.strength.reassurance,
    line: COPY.strength.weak(memoryFactor),
    command: input.command,
  };
}

/** What is known about one queued message, as facts. The sentence is written below. */
export interface DeliveryFact {
  readonly id: string;
  readonly recipient: string;
  readonly state: 'queued' | 'unroutable' | 'sent' | 'acknowledged';
  readonly attempts: number;
}

export interface DeliveryInput {
  readonly items: readonly DeliveryFact[];
}

export interface DeliveryEntryView {
  readonly id: string;
  readonly recipient: string;
  readonly state: DeliveryFact['state'];
  readonly line: string;
  /** True for the states a person can do something about. */
  readonly needsYou: boolean;
}

export interface DeliveryView {
  readonly heading: string;
  readonly empty: string;
  readonly entries: readonly DeliveryEntryView[];
  /** The one-line summary, or null when every message is accounted for. */
  readonly line: string | null;
}

export const NO_DELIVERY: DeliveryInput = { items: [] };

export function buildDelivery(input: DeliveryInput | undefined): DeliveryView {
  const items = input?.items ?? [];
  const entries = items.map((item) => ({
    id: item.id,
    recipient: item.recipient,
    state: item.state,
    line: lineFor(item),
    // `unroutable` and `queued` are the two a person can act on — the first by giving the
    // counterparty a reachable address, the second by being online. `sent` and `acknowledged`
    // are reports, not requests.
    needsYou: item.state === 'unroutable' || item.state === 'queued',
  }));
  const stuck = entries.filter((e) => e.needsYou).length;
  return {
    heading: COPY.delivery.heading,
    empty: COPY.delivery.empty,
    entries,
    line: stuck === 0 ? null : COPY.delivery.stuck(stuck),
  };
}

/**
 * Four states, four sentences, and the distinction between the middle two is the whole point.
 *
 * A successful git push proves bytes reached a repository; a hub answering 200 proves a relay
 * accepted a sealed blob it cannot read. Neither proves anybody read anything. Only a signature
 * from the recipient does, which is why `acknowledged` is the one state no transport can set by
 * itself — and why "sent" must never be worded as "delivered".
 */
function lineFor(item: DeliveryFact): string {
  switch (item.state) {
    case 'acknowledged':
      return COPY.delivery.acknowledged(item.recipient);
    case 'sent':
      return COPY.delivery.sent(item.recipient);
    case 'unroutable':
      return COPY.delivery.unroutable(item.recipient);
    default:
      return COPY.delivery.queued(item.recipient, item.attempts);
  }
}
