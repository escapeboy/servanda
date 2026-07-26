import { describe, expect, it } from 'vitest';
import { MemoryHub } from '../src/hub.js';
import { HubClient, HubTransportError, hubFetch } from '../src/hub-transport.js';
import { signMessage } from '../src/messages.js';
import { persona } from './support/fixture.js';

/**
 * §6.1 hub transport: `POST /servanda/v0/deliver`, `GET /servanda/v0/inbox?persona=…`
 * "authenticated by persona signature challenge" (§6.1), delivered "only to the persona" (§6.7).
 *
 * No socket is opened anywhere in this file: the HTTP client is injected, and it is the routes
 * and status codes that are under test, not a network.
 */

const A = persona(0);
const B = persona(1);
const NOW = () => new Date('2026-07-25T09:00:00.000Z');

function stack(opts: { ttlDays?: number } = {}) {
  const hub = new MemoryHub({ now: NOW, ...opts });
  const client = (p: { personaId: string; privateKey: string }) =>
    new HubClient({
      baseUrl: 'https://hub.example',
      persona: p.personaId,
      privateKey: p.privateKey,
      fetch: hubFetch(hub),
      now: NOW,
    });
  return { hub, client };
}

const note = (from: { personaId: string; privateKey: string }) =>
  signMessage('recon_request', { edges: [] }, from.personaId, '2026-07-25T09:00:00.000Z', from.privateKey);

describe('§6.1 hub transport', () => {
  it('delivers and reads back through the documented routes', async () => {
    const { client } = stack();
    await client(A).send(B.personaId, note(A));
    const delivered = await client(B).receive(B.personaId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sender).toBe(A.personaId);
  });

  it('§6.1: an unauthenticated inbox read is refused and answered with a challenge', async () => {
    const { hub } = stack();
    const http = hubFetch(hub);
    const res = await http(`https://hub.example/servanda/v0/inbox?persona=${B.personaId}`, { method: 'GET' });
    expect(res.status).toBe(401);
    expect((await res.json()) as { challenge: string }).toHaveProperty('challenge');
  });

  it('§6.7: a signature from the wrong key does not open the queue', async () => {
    const { hub, client } = stack();
    await client(A).send(B.personaId, note(A));
    // A holds a valid key, but not B's — signing B's challenge is exactly what it cannot do.
    const impostor = new HubClient({
      baseUrl: 'https://hub.example',
      persona: B.personaId,
      privateKey: A.privateKey,
      fetch: hubFetch(hub),
      now: NOW,
    });
    await expect(impostor.receive(B.personaId)).rejects.toThrow(HubTransportError);
  });

  it('a challenge is single-use', async () => {
    const { hub } = stack();
    const challenge = hub.challenge(B.personaId);
    const { withSignature } = await import('@servanda/crypto');
    const auth = withSignature(
      {
        v: 'servanda/0.1' as const,
        type: 'inbox_auth' as const,
        persona: B.personaId,
        challenge,
        issued_at: '2026-07-25T09:00:00.000Z',
      },
      B.privateKey,
    );
    expect(hub.inbox(B.personaId, auth)).toEqual([]);
    expect(() => hub.inbox(B.personaId, auth)).toThrow(/already spent/);
  });

  it('a client reads only its own inbox', async () => {
    const { client } = stack();
    await expect(client(A).receive(B.personaId)).rejects.toThrow(/only its own inbox/);
  });

  it('an envelope the hub tampered with decrypts to nothing and is dropped', async () => {
    const { hub, client } = stack();
    await client(A).send(B.personaId, note(A));
    const stored = hub.visibleState()[0]!;
    // A dishonest relay flips a ciphertext byte. §6.3: fabrication is caught at the recipient.
    stored.envelope.sealed.ciphertext = `ff${stored.envelope.sealed.ciphertext.slice(2)}`;
    expect(await client(B).receive(B.personaId)).toEqual([]);
  });

  it('§6.7: queued messages expire after the hub’s TTL', async () => {
    let hubClock = new Date('2026-07-25T09:00:00.000Z');
    const hub = new MemoryHub({ now: () => hubClock, ttlDays: 30 });
    const client = new HubClient({
      baseUrl: 'https://hub.example',
      persona: A.personaId,
      privateKey: A.privateKey,
      fetch: hubFetch(hub),
      now: NOW,
    });
    await client.send(B.personaId, note(A));
    expect(hub.visibleState()).toHaveLength(1);
    hubClock = new Date('2026-09-25T09:00:00.000Z'); // two months later
    const challenge = hub.challenge(B.personaId);
    const { withSignature } = await import('@servanda/crypto');
    const auth = withSignature(
      {
        v: 'servanda/0.1' as const,
        type: 'inbox_auth' as const,
        persona: B.personaId,
        challenge,
        issued_at: '2026-07-25T09:00:00.000Z',
      },
      B.privateKey,
    );
    // §6.7: "Delivery is optimization; reconciliation is the guarantee." Losing this is fine.
    expect(hub.inbox(B.personaId, auth)).toEqual([]);
  });
});
