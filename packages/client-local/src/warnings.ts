import { ARGON2ID_PARAMS } from '@servanda/crypto';
import type { Vault } from '@servanda/vault';
import type { DeliveryFact, DeliveryInput, VaultStrengthInput } from '@servanda/client-web';

/**
 * The vault's own facts, shaped for a surface.
 *
 * `@servanda/client-web` deliberately depends on `@servanda/types` and nothing else, so it can
 * neither open a vault nor read a KDF. This package already depends on both sides, which makes
 * it the one place the mapping can live without either half growing a dependency it should not
 * have. It carries FACTS across, never sentences: the words belong to the surface that knows who
 * is reading (M-21).
 *
 * Written because three sprints in a row produced a view nobody fed. `Vault.kdfProfile()` had
 * exactly one caller — itself — and after the notices were built it had two: itself and a test.
 * A surface that accepts an input nobody passes is the same defect as a value nobody renders,
 * one level up.
 */

/** The command that raises an old vault, and the only piece of text that crosses verbatim. */
export const UPGRADE_COMMAND = 'SERVANDA_UPGRADE_KEY=1 servanda-init';

export function vaultStrengthOf(vault: Vault): VaultStrengthInput {
  const profile = vault.kdfProfile();
  return {
    // `kdfProfile()` returns null when the keyset cannot be read at all. Passed through as null
    // rather than defaulted to "fine": not knowing is not the same as being current, and the
    // surface treats null as "say nothing" only because a guess would be worse than silence.
    profile: profile === null ? null : { m: profile.m, t: profile.t, p: profile.p },
    current: { m: ARGON2ID_PARAMS.m, t: ARGON2ID_PARAMS.t, p: ARGON2ID_PARAMS.p },
    command: UPGRADE_COMMAND,
  };
}

/**
 * What the outbox knows about each message, without a transport in the picture.
 *
 * `FederatedNode.outbound()` composes the same facts AND a sentence, and it lives in a package
 * no client can import — git and HTTP transports behind a browser bundle is not a thing that can
 * happen. But the STATE is in the vault: `OutboxDelivery` records `sent_at`, `acknowledged_at`
 * and `unroutable_since`, so a reader needs no courier to say what is known.
 *
 * The order of the checks is the order of certainty, strongest first. `acknowledged_at` is the
 * only member a transport cannot set by itself — §4.1 means it can only come from the
 * recipient's own signature — so it wins over `sent_at`, which proves nothing about a reader.
 * `unroutable_since` is checked before `sent_at` for a different reason: a message sent once and
 * since become unroutable is a message that will not arrive again, and telling somebody it is on
 * its way would be the older, weaker fact winning.
 */
export function deliveryOf(vault: Vault, persona: string): DeliveryInput {
  const items: DeliveryFact[] = vault.listOutbox(persona).map((item) => ({
    id: item.id,
    recipient: item.recipient,
    state: stateOf(item.delivery),
    attempts: item.delivery.attempts,
  }));
  return { items };
}

function stateOf(d: {
  acknowledged_at: string | null;
  unroutable_since: string | null;
  sent_at: string | null;
}): DeliveryFact['state'] {
  if (d.acknowledged_at !== null) return 'acknowledged';
  if (d.unroutable_since !== null) return 'unroutable';
  if (d.sent_at !== null) return 'sent';
  return 'queued';
}
