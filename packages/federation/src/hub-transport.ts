import { canonicalBytes, openSealed, sealToPersona, withSignature } from '@servanda/crypto';
import type { HubEnvelope, WireMessage } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import type { FetchLike, Transport } from './transport.js';
import { verifyMessage } from './messages.js';
import type { InboxAuth, MemoryHub } from './hub.js';

/**
 * §6.1 hub transport — `POST /servanda/v0/deliver`, `GET /servanda/v0/inbox?persona=…`.
 *
 * §6.3 is not optional here: the ENTIRE wire message, including `sender` and `sig`, is sealed
 * to the recipient persona before it is handed to the relay. What leaves this class is
 * `{ v, type, recipient, sealed, sent_at }` and nothing else — see `HUB_VISIBLE_FIELDS`.
 *
 * The HTTP client is injected (`FetchLike`). That is a conformance property, not a testing
 * convenience: nothing in this package imports a network module or touches a global `fetch`,
 * so a node that never configures a hub cannot be made to open a socket (M-10).
 */

const DELIVER = '/servanda/v0/deliver';
const INBOX = '/servanda/v0/inbox';

export class HubTransportError extends Error {
  override name = 'HubTransportError';
}

/**
 * The envelope fields the ciphertext is bound to.
 *
 * `recipient` and `sent_at` travel OUTSIDE the sealed blob — a hub has to read the first to route
 * and the second to expire a queue entry. Outside meant unauthenticated: a courier could rewrite
 * `sent_at` on anything it held and no recipient could tell. Binding them as AEAD associated data
 * leaves them readable and makes them immutable, which is the property §6.3 actually wants from a
 * blind courier — see nothing, change nothing.
 *
 * Exported because it is part of the envelope's contract, not an internal of the client: anything
 * that opens a sealed blob has to reproduce these bytes exactly.
 */
export function hubEnvelopeAad(fields: { recipient: string; sent_at: string }): Uint8Array {
  return canonicalBytes({
    v: PROTOCOL_VERSION,
    type: 'hub_envelope',
    recipient: fields.recipient,
    sent_at: fields.sent_at,
  });
}

export class NoRecipientKey extends HubTransportError {
  override name = 'NoRecipientKey';
}

export interface HubClientOptions {
  baseUrl: string;
  persona: string;
  /** Signs the §6.1 inbox challenge. Ed25519; no longer used for key agreement. */
  privateKey: string;
  /** §6.3 — opens sealed inbound payloads. The persona's own X25519 key, `m/7391'/{n}'/1'`. */
  dhPrivateKey: string;
  fetch: FetchLike;
  /**
   * Where the recipient's X25519 key comes from, and the reason it is INJECTED.
   *
   * A sealing key must be one somebody authenticated — here, a §6.7 inbox record whose signature
   * verifies against the persona it names (M-17). This class deliberately cannot look one up on
   * its own: resolution is a policy decision about whom to believe, and a transport that could
   * invent an answer is a transport that could be talked into the wrong one.
   *
   * Returning `null` refuses the send. There is no fallback (R5) — nothing here can turn a
   * persona_id into a key, which is what removes the old construction rather than deprecating it.
   */
  resolveDhKey: (persona: string) => string | null;
  now?: () => Date;
}

export class HubClient implements Transport {
  readonly kind = 'hub' as const;
  private readonly baseUrl: string;
  readonly persona: string;
  private readonly privateKey: string;
  private readonly dhPrivateKey: string;
  private readonly http: FetchLike;
  private readonly resolveDhKey: (persona: string) => string | null;
  private readonly clock: () => Date;

  constructor(opts: HubClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.persona = opts.persona;
    this.privateKey = opts.privateKey;
    this.dhPrivateKey = opts.dhPrivateKey;
    this.http = opts.fetch;
    this.resolveDhKey = opts.resolveDhKey;
    this.clock = opts.now ?? (() => new Date());
  }

  /** §6.3: seal the whole message to the recipient, then hand the relay the envelope. */
  sealFor(recipient: string, message: WireMessage): HubEnvelope {
    const dhKey = this.resolveDhKey(recipient);
    if (dhKey === null) {
      // Refusing is the correct outcome, not a degraded one. §6.7 makes delivery an optimization
      // and reconciliation the guarantee, so an undeliverable message costs a round of recon —
      // whereas sealing to a key nobody authenticated costs the confidentiality §6.3 exists for.
      throw new NoRecipientKey(
        `no authenticated X25519 key for ${recipient.slice(0, 16)}…; refusing to seal (§6.3)`,
      );
    }
    const sent_at = this.clock().toISOString();
    return {
      v: PROTOCOL_VERSION,
      type: 'hub_envelope',
      recipient,
      sealed: sealToPersona(
        recipient,
        dhKey,
        canonicalBytes(message as unknown as Record<string, unknown>),
        hubEnvelopeAad({ recipient, sent_at }),
      ),
      sent_at,
    };
  }

  async send(recipient: string, message: WireMessage): Promise<void> {
    const res = await this.http(`${this.baseUrl}${DELIVER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.sealFor(recipient, message)),
    });
    if (!res.ok) throw new HubTransportError(`hub refused delivery: HTTP ${res.status}`);
  }

  async receive(persona: string): Promise<WireMessage[]> {
    if (persona !== this.persona) {
      // A hub client can only open what its own key can decrypt; asking for someone else's
      // inbox is a programming error, and answering it would be an M-4a violation besides.
      throw new HubTransportError('a hub client reads only its own inbox (§6.7)');
    }
    const url = `${this.baseUrl}${INBOX}?persona=${persona}`;

    // Signature challenge (§6.1): an unauthenticated read is answered with a nonce to sign.
    const unauth = await this.http(url, { method: 'GET' });
    if (unauth.ok) {
      throw new HubTransportError('§6.1: a hub MUST NOT serve an inbox without a signed challenge');
    }
    const challenge = (await unauth.json()) as { challenge?: unknown };
    if (typeof challenge.challenge !== 'string') {
      throw new HubTransportError(`hub did not issue a challenge: HTTP ${unauth.status}`);
    }

    const auth = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'inbox_auth' as const,
        persona,
        // §6.1: the hub this signature is for. A client that omits it hands every other hub in
        // its own §6.7 list a token that opens this queue.
        audience: this.baseUrl,
        challenge: challenge.challenge,
        issued_at: this.clock().toISOString(),
      },
      this.privateKey,
    ) as InboxAuth;

    const res = await this.http(url, {
      method: 'GET',
      headers: { authorization: `Servanda ${Buffer.from(JSON.stringify(auth), 'utf8').toString('base64')}` },
    });
    if (!res.ok) throw new HubTransportError(`hub refused inbox: HTTP ${res.status}`);

    const body = (await res.json()) as { envelopes?: unknown };
    const envelopes = Array.isArray(body.envelopes) ? body.envelopes : [];
    const out: WireMessage[] = [];
    for (const raw of envelopes) {
      const message = this.open(raw);
      // §6.3: "fabrication is prevented by signature verification at recipients regardless of
      // hub honesty" — an envelope the hub forged decrypts to nothing, and one it replayed
      // still has to carry a valid sender signature.
      if (message) out.push(message);
    }
    return out;
  }

  private open(raw: unknown): WireMessage | null {
    const envelope = raw as HubEnvelope;
    try {
      const plaintext = openSealed(
        this.dhPrivateKey,
        this.persona,
        envelope.sealed,
        hubEnvelopeAad(envelope),
      );
      return verifyMessage(JSON.parse(Buffer.from(plaintext).toString('utf8')));
    } catch {
      return null;
    }
  }

  /** Hub delivery is synchronous; there is no shared medium to reconcile with. */
  async sync(): Promise<void> {}
}

/**
 * A `FetchLike` that routes to an in-process `MemoryHub`. Tests drive the real HTTP shape —
 * routes, status codes, the 401-with-challenge handshake — while opening no socket.
 */
export function hubFetch(hub: MemoryHub): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = new URL(url, 'http://hub.invalid');
    const ok = (status: number, body: unknown) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });

    if (method === 'POST' && parsed.pathname === DELIVER) {
      try {
        return ok(200, hub.deliver(JSON.parse(init?.body ?? 'null')));
      } catch (err) {
        return ok(400, { error: (err as Error).message });
      }
    }

    if (method === 'GET' && parsed.pathname === INBOX) {
      const persona = parsed.searchParams.get('persona') ?? '';
      const header = init?.headers?.['authorization'];
      if (!header) return ok(401, { challenge: hub.challenge(persona) });
      try {
        const auth = JSON.parse(Buffer.from(header.replace(/^Servanda\s+/, ''), 'base64').toString('utf8'));
        return ok(200, { envelopes: hub.inbox(persona, auth) });
      } catch (err) {
        return ok(403, { error: (err as Error).message });
      }
    }

    return ok(404, { error: `no such route: ${method} ${parsed.pathname}` });
  };
}
