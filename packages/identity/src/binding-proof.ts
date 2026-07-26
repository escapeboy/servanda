import { verifyObject, withSignature } from '@servanda/crypto';
import { BindingProof, PROTOCOL_VERSION } from '@servanda/types';

/**
 * §1.6 `ext external-proof` — "a signed statement published on a controlled external channel
 * (repo/gist/domain)".
 *
 * The evidence is not the signature; a persona can sign anything about itself. The evidence is
 * that the statement was found *on the channel it names*. So the observation is a required
 * argument: this module will not grade a binding proof that arrived out of band.
 */

export type BindingProofRejection =
  | 'malformed'
  | 'signature-invalid'
  | 'persona-mismatch'
  /** The proof was not observed on the channel it claims. Self-assertion, not evidence. */
  | 'not-observed-on-its-channel';

export interface BindingProofObservation {
  /** Where the verifier actually found this object. */
  readonly channelUrl: string;
}

export interface BindingProofContext {
  readonly observed: BindingProofObservation;
  /** The persona the caller is verifying. A mismatch is refused. */
  readonly persona?: string;
}

export type BindingProofVerdict =
  | { readonly ok: true; readonly proof: BindingProof }
  | {
      readonly ok: false;
      readonly reason: BindingProofRejection;
      readonly detail: string | null;
    };

/**
 * Channel URLs are compared after normalising the parts that carry no meaning (trailing
 * slash, default port, host case). Everything else — scheme, path, query — must match: a
 * proof found at a different path on the same host was not published where it says it was.
 */
export function normalizeChannelUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null; // a controlled channel that is not authenticated
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.port === '443') u.port = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function verifyBindingProof(input: unknown, ctx: BindingProofContext): BindingProofVerdict {
  const parsed = BindingProof.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed', detail: parsed.error.issues[0]?.message ?? null };
  }
  const proof = parsed.data;

  if (ctx.persona !== undefined && proof.persona !== ctx.persona) {
    return { ok: false, reason: 'persona-mismatch', detail: `binds ${proof.persona}` };
  }

  const claimed = normalizeChannelUrl(proof.channel_url);
  const observed = normalizeChannelUrl(ctx.observed.channelUrl);
  if (claimed === null || observed === null || claimed !== observed) {
    return {
      ok: false,
      reason: 'not-observed-on-its-channel',
      detail: `claims ${proof.channel_url}, observed at ${ctx.observed.channelUrl}`,
    };
  }

  // Signed by the persona it binds — nobody else's signature makes this statement.
  if (!verifyObject(proof, proof.persona)) {
    return { ok: false, reason: 'signature-invalid', detail: `does not verify against ${proof.persona}` };
  }

  return { ok: true, proof };
}

/** Build a §1.6 binding proof. The persona's own key signs; there is no other signer. */
export function signBindingProof(input: {
  readonly persona: string;
  readonly channelUrl: string;
  readonly privateKey: string;
}): BindingProof {
  const core = {
    v: PROTOCOL_VERSION,
    type: 'binding_proof' as const,
    persona: input.persona,
    channel_url: input.channelUrl,
  };
  return BindingProof.parse(withSignature(core, input.privateKey));
}
