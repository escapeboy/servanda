import { describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { MemoryHub } from '../src/hub.js';
import { HubClient, hubFetch } from '../src/hub-transport.js';
import { signMessage } from '../src/messages.js';
import { dhDirectory, persona } from './support/fixture.js';

/**
 * §6.1: a challenge signature names the hub it is for.
 *
 * The property is non-transferability. A challenge is public by construction — it is issued
 * BEFORE authentication, so anybody can ask for one — and that is fine. What must not be
 * transferable is the SIGNATURE over it.
 *
 * Without an audience the signed blob is a bearer token valid at every hub at once, which turns
 * §6.7's ordered hub list from an availability feature into the attack surface: one compromised
 * hub in the list drains the persona's queue at all the others.
 */

const A = persona(0);
const B = persona(1);
const NOW = () => new Date('2026-07-25T09:00:00.000Z');
const directory = dhDirectory([A, B]);

const HONEST = 'https://honest.example';
const HOSTILE = 'https://hostile.example';

const note = (from: { personaId: string; privateKey: string }, to: string) =>
  signMessage('recon_request', { edges: [] }, from.personaId, to, '2026-07-25T09:00:00.000Z', from.privateKey);

describe('§6.1: a challenge signature is not a bearer token', () => {
  it('refuses an authentication minted for another hub', async () => {
    // Two hubs, as §6.7 intends: B lists both so it stays reachable when one is down.
    const honest = new MemoryHub({ now: NOW, baseUrl: HONEST });
    const hostile = new MemoryHub({ now: NOW, baseUrl: HOSTILE });

    // A delivers to B at the honest hub. This is the queue under attack.
    const sender = new HubClient({
      baseUrl: HONEST,
      persona: A.personaId,
      privateKey: A.privateKey,
      dhPrivateKey: A.dhPrivateKey,
      fetch: hubFetch(honest),
      resolveDhKey: directory,
      now: NOW,
    });
    await sender.send(B.personaId, note(A, B.personaId));
    expect(honest.visibleState()).toHaveLength(1);

    // The hostile hub obtains the honest hub's outstanding challenge for B. No credential is
    // needed: a challenge is minted before authentication, which is what makes it public.
    const stolen = honest.challenge(B.personaId);

    // It serves that nonce to B as though it were its own, and B — a correct client, doing
    // exactly what §6.1 asks — signs it.
    const signedForHostile = withSignature(
      {
        v: 'servanda/0.2' as const,
        type: 'inbox_auth' as const,
        persona: B.personaId,
        audience: HOSTILE,
        challenge: stolen,
        issued_at: '2026-07-25T09:00:00.000Z',
      },
      B.privateKey,
    );

    // Replayed at the honest hub, where the nonce is genuine and the signature is genuine.
    // The only thing standing between an attacker and B's whole retained queue is the audience.
    expect(() => honest.inbox(B.personaId, signedForHostile)).toThrow(/audience|another hub/i);
  });

  it('accepts an authentication minted for this hub', async () => {
    const honest = new MemoryHub({ now: NOW, baseUrl: HONEST });
    const auth = withSignature(
      {
        v: 'servanda/0.2' as const,
        type: 'inbox_auth' as const,
        persona: B.personaId,
        audience: HONEST,
        challenge: honest.challenge(B.personaId),
        issued_at: '2026-07-25T09:00:00.000Z',
      },
      B.privateKey,
    );
    expect(honest.inbox(B.personaId, auth)).toEqual([]);
  });
});
