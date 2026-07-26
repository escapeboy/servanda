import { publicKeyFromPrivate, signObject, verifyObject } from '@servanda/crypto';
import { PROTOCOL_VERSION, PersonaLink } from '@servanda/types';

/**
 * §1.6 persona-linking statement — `{type:"link", personas:[A,B], sig_A, sig_B}`, "both persona
 * keys sign; proves common ownership without exposing the root".
 *
 * SPEC GAP (same class as the rotation contradiction, servanda-protocol#17, and reported
 * alongside it). `sig_A`/`sig_B` have no defined signing preimage either: the universal rule
 * excludes only a field named `sig`, so each signature would have to cover the other. Unlike
 * rotation — where refusing the ambiguous encoding still leaves a verifiable single-`sig` form
 * — refusing here would make §1.6's link object unimplementable, so this module adopts one
 * documented, NON-NORMATIVE interpretation and states it loudly:
 *
 *     preimage = sha256(JCS({v, type, personas}))     ← both A and B sign these same bytes
 *
 * Both signatures are required, each is checked against its own position in `personas`, and a
 * signature that verifies in the wrong position is rejected rather than accepted "somewhere".
 *
 * The other half of §1.6 is a process rule, not a crypto rule: linking is "explicitly
 * user-initiated only". This module has exactly one function that emits a link, it takes an
 * explicit intent token, and nothing else in @servanda/identity produces or infers one.
 */

export type LinkRejection =
  | 'malformed'
  /** Both entries name the same persona: a link that proves nothing. */
  | 'self-link'
  /** `sig_A` does not verify against `personas[0]`. */
  | 'sig-a-invalid'
  /** `sig_B` does not verify against `personas[1]`. */
  | 'sig-b-invalid'
  /** Both signature slots carry the same bytes — one persona signing twice. */
  | 'duplicate-signature';

export type LinkVerdict =
  | { readonly ok: true; readonly link: PersonaLink; readonly personas: readonly [string, string] }
  | { readonly ok: false; readonly reason: LinkRejection; readonly detail: string | null };

export type LinkCore = {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: 'link';
  readonly personas: readonly [string, string];
};

/** The bytes both personas sign. See the NON-NORMATIVE note above. */
export function linkCore(personas: readonly [string, string]): LinkCore {
  return { v: PROTOCOL_VERSION, type: 'link', personas };
}

export function verifyPersonaLink(input: unknown): LinkVerdict {
  const parsed = PersonaLink.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed', detail: parsed.error.issues[0]?.message ?? null };
  }
  const link = parsed.data;
  const [a, b] = link.personas;

  if (a === b) return { ok: false, reason: 'self-link', detail: 'both entries name one persona' };
  if (link.sig_A === link.sig_B) {
    return { ok: false, reason: 'duplicate-signature', detail: 'sig_A and sig_B are identical' };
  }

  const core = linkCore([a, b]);
  if (!verifyObject({ ...core, sig: link.sig_A }, a)) {
    return { ok: false, reason: 'sig-a-invalid', detail: `sig_A does not verify against ${a}` };
  }
  if (!verifyObject({ ...core, sig: link.sig_B }, b)) {
    return { ok: false, reason: 'sig-b-invalid', detail: `sig_B does not verify against ${b}` };
  }
  return { ok: true, link, personas: [a, b] };
}

/**
 * The intent token. §1.6 says linking is "explicitly user-initiated only", and §1.1 says the
 * root key "signs nothing that leaves the vault except persona-linking statements and rotation
 * statements, both of which are explicitly user-initiated". A required literal is how that
 * sentence becomes something a code path cannot skip: no default, no boolean that a caller can
 * pass `true` for by habit, and no overload without it.
 */
export const USER_INITIATED = 'user-initiated' as const;
export type UserInitiated = typeof USER_INITIATED;

export class LinkNotUserInitiated extends Error {
  constructor() {
    super(
      'persona linking is explicitly user-initiated only (§1.6): pass intent: USER_INITIATED, ' +
        'and only in response to a person asking for it',
    );
    this.name = 'LinkNotUserInitiated';
  }
}

/**
 * Build a §1.6 persona link. The ONLY function in this package that emits one.
 *
 * Both private keys must be present at the call site, which is itself a limit: a service that
 * holds one persona's key cannot mint a link on the user's behalf.
 */
export function signPersonaLink(input: {
  readonly privateKeyA: string;
  readonly privateKeyB: string;
  readonly intent: UserInitiated;
}): PersonaLink {
  if (input.intent !== USER_INITIATED) throw new LinkNotUserInitiated();
  const a = publicKeyFromPrivate(input.privateKeyA);
  const b = publicKeyFromPrivate(input.privateKeyB);
  if (a === b) throw new TypeError('a persona cannot be linked to itself');
  const core = linkCore([a, b]);
  return PersonaLink.parse({
    ...core,
    personas: [a, b],
    sig_A: signObject(core, input.privateKeyA),
    sig_B: signObject(core, input.privateKeyB),
  });
}
