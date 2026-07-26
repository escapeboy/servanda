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

export interface HubClientOptions {
  baseUrl: string;
  persona: string;
  /** Needed to open sealed inbound payloads and to sign the inbox challenge. */
  privateKey: string;
  fetch: FetchLike;
  now?: () => Date;
}

export class HubClient implements Transport {
  readonly kind = 'hub' as const;
  private readonly baseUrl: string;
  readonly persona: string;
  private readonly privateKey: string;
  private readonly http: FetchLike;
  private readonly clock: () => Date;

  constructor(opts: HubClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.persona = opts.persona;
    this.privateKey = opts.privateKey;
    this.http = opts.fetch;
    this.clock = opts.now ?? (() => new Date());
  }

  /** §6.3: seal the whole message to the recipient, then hand the relay the envelope. */
  sealFor(recipient: string, message: WireMessage): HubEnvelope {
    return {
      v: PROTOCOL_VERSION,
      type: 'hub_envelope',
      recipient,
      sealed: sealToPersona(recipient, canonicalBytes(message as unknown as Record<string, unknown>)),
      sent_at: this.clock().toISOString(),
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
      const plaintext = openSealed(this.privateKey, envelope.sealed);
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
