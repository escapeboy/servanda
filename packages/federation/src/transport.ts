import type { WireMessage } from '@servanda/types';

/**
 * §6.1 transport abstraction. "Wire messages are transport-agnostic signed JSON."
 *
 * Everything above this interface — reconciliation, recovery, the inbox — is written once and
 * runs over either transport. The two v0 transports differ only in what the courier can see:
 *
 * - **git**: a shared repository. Confidentiality is repository access; every party with a
 *   clone reads every file. Suits team scopes (§6.1: "self-hosted, offline-tolerant").
 * - **hub**: an HTTPS relay that MUST be blind (§6.3) — the sender seals the whole wire
 *   message to the recipient persona, so the relay sees recipient, ciphertext, timestamps.
 *
 * §6.7: "Delivery is optimization; reconciliation is the guarantee." A transport is allowed to
 * lose, duplicate or reorder messages. `receive` therefore returns everything currently
 * addressable to the persona, and every consumer must be idempotent.
 */
export interface Transport {
  readonly kind: 'git' | 'hub';

  /** Hand a signed message to the courier for `recipient`. */
  send(recipient: string, message: WireMessage): Promise<void>;

  /** Everything the courier currently holds for `persona`, signature-verified. */
  receive(persona: string): Promise<WireMessage[]>;

  /**
   * Exchange with the shared medium (git fetch/push). Hub delivery is synchronous, so its
   * implementation is a no-op — the method exists so callers need not know which they hold.
   */
  sync(): Promise<void>;
}

/** Minimal HTTP surface the hub transport needs, injected so nothing here opens a socket. */
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * The injected HTTP client. Declared structurally rather than reusing the global `fetch` type:
 * this package's `lib` is ES2023 with no DOM, and — more to the point — a transport that
 * reaches for a global has no seam a test can prove it did not use.
 */
export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;
