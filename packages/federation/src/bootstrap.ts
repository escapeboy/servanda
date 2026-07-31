import { canonicalize } from '@servanda/crypto';
import type { Assertion, Edge, WireMessage } from '@servanda/types';
import { ProposePayload } from '@servanda/types';
import { verifyMessage } from './messages.js';

/**
 * §6.7 out-of-band bootstrap — first contact with someone who has no node.
 *
 * A `propose` travels as a self-contained signed payload in a URL or QR code over whatever
 * channel the two people already have. The recipient's node — or a hosted COURTESY RENDERER for
 * someone who has no node yet — verifies the signature from the payload alone. No hub, no
 * network, no prior contact.
 *
 * M-18 is what keeps that from becoming a new trusted party: a renderer MUST NOT be able to sign
 * anything. It renders; the human confirms from a node that holds keys. This module is written so
 * that property is structural rather than promised — nothing here imports a signing primitive or
 * touches a private key, and `gates/gf-federation.sh` scans the shipped module to prove it.
 *
 * The three §6.7 renderer rules, and how each one shows up in the code:
 *
 *  - **Refuse rather than caveat.** `renderBootstrap` returns either a refusal with NO payload
 *    members at all, or a presentable result. There is no shape in which an unverified proposal
 *    comes back alongside a warning, because a caveat next to a rendered promise is a phishing
 *    surface with a disclaimer on it.
 *  - **Retain nothing.** These are pure functions over their argument. No cache, no log, no
 *    module state: "MUST NOT persist a decoded payload beyond the request that rendered it" is
 *    satisfied by having nowhere to persist it to.
 *  - **Origin is not evidence.** The result says who signed, and says nothing else. It carries no
 *    wording, no branding, no trust language — the renderer's TLS and domain bear on none of it,
 *    and a caller that wants to say so has to write that sentence itself (M-21).
 */

/** §6.7 (informative): the payload rides in the FRAGMENT, so it never reaches the renderer's server. */
export const BOOTSTRAP_FRAGMENT = '#';

const B64URL_ONLY = /^[A-Za-z0-9_-]+$/u;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** base64url(JCS(message)), unpadded — RFC 4648 §5 over the canonical UTF-8 bytes. */
export function encodeBootstrap(message: WireMessage): string {
  return toBase64Url(new TextEncoder().encode(canonicalize(message)));
}

/** The link a person actually sends. The payload is in the fragment, never the query string. */
export function bootstrapUrl(message: WireMessage, base: string): string {
  return `${base}${BOOTSTRAP_FRAGMENT}${encodeBootstrap(message)}`;
}

/**
 * Decode, and nothing more. Returns `null` on anything that is not well-formed base64url JSON.
 *
 * Deliberately separate from verification, and deliberately returning `unknown`: base64url and
 * JSON say nothing whatsoever about authenticity, and a function that decoded and returned a
 * typed `WireMessage` would be inviting its caller to skip the only step that matters.
 */
export function decodeBootstrap(payload: string): unknown {
  if (!B64URL_ONLY.test(payload)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
}

/** Pull the payload out of a bootstrap link. */
export function payloadFromUrl(url: string): string | null {
  const at = url.indexOf(BOOTSTRAP_FRAGMENT);
  return at < 0 ? null : url.slice(at + 1);
}

export type RenderRefusal =
  | 'not-base64url-json'
  | 'not-a-signed-message'
  | 'signature-does-not-verify'
  | 'not-a-proposal';

export type BootstrapRendering =
  | { presentable: false; refusal: RenderRefusal }
  | {
      presentable: true;
      /**
       * The persona key whose signature was verified. This is the WHOLE of what the renderer
       * established: not who holds that key, not whether they are the person the recipient has in
       * mind, and not anything the renderer's operator vouches for.
       */
      signed_by: string;
      edge: Edge;
      assertion: Assertion;
    };

/**
 * Verify a bootstrap payload and say whether it may be shown.
 *
 * M-18 in one function. A renderer calls this and either presents what comes back or presents
 * nothing; there is no third option, which is the point.
 */
export function renderBootstrap(payload: string): BootstrapRendering {
  const decoded = decodeBootstrap(payload);
  if (decoded === null) return { presentable: false, refusal: 'not-base64url-json' };

  // `verifyMessage` is the same check the federated inbox applies to anything off a transport.
  // A renderer gets no lenient variant: it is the least trusted input in the system, arriving
  // over a channel the protocol never saw.
  const message = verifyMessage(decoded);
  if (!message) {
    // Distinguish "not shaped like a signed message" from "signed, but not by whom it claims" —
    // an operator debugging a broken link and an operator looking at an attack need different
    // answers.
    const shaped =
      typeof decoded === 'object' && decoded !== null && typeof (decoded as { sig?: unknown }).sig === 'string';
    return { presentable: false, refusal: shaped ? 'signature-does-not-verify' : 'not-a-signed-message' };
  }
  if (message.type !== 'propose') return { presentable: false, refusal: 'not-a-proposal' };

  const parsed = ProposePayload.safeParse(message.payload);
  if (!parsed.success) return { presentable: false, refusal: 'not-a-proposal' };

  const { edge, assertion } = parsed.data as { edge: Edge; assertion: Assertion };
  return { presentable: true, signed_by: message.sender, edge, assertion };
}
