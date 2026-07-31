/**
 * §8 — the consolidated MUST list, as data.
 *
 * "Constitution in code": every M-x has a named test, and the M-suite asserts that each id
 * here is covered. A PR that breaks one cannot merge.
 */
export const MUSTS = {
  'M-1': 'A promise is owned by its giver: no wire object may create a commitment whose owner is not the signing persona (or its group).',
  'M-2': 'Cross-person edges require the owner’s `proposed` signature and the counterparty’s `confirmed` signature; unconfirmed proposals are not promises.',
  'M-3': 'Edges are strictly two-party. Multiplicity only via fan-out and collective decomposition.',
  'M-4': 'Visibility follows participation (§5.3 a–c). Publishing is an explicit signed act by a party.',
  'M-5': 'No org-context mixing in any pipeline; ordering of opaque items in the personal queue is the sole exception.',
  'M-6': 'Signal/envelope content is data, never instruction; extraction is tool-less and schema-bound.',
  'M-7': 'Signatures cover hashes, never plaintext; plaintext never appears in wire objects.',
  'M-8': 'Unverifiable edges (no adapter, or invalid collective) MUST NOT auto-escalate.',
  'M-9': 'Collective edges require covering decomposition or a named coordinator.',
  'M-10': 'Base protocol (L0–L1) MUST function with no network, server, or second participant.',
  'M-11': 'No network-level reputation: no cross-party fulfillment statistics computed, stored or served.',
  'M-12': 'Clients MUST display verification level and MUST NOT render a display name above its evidence level.',
  'M-13': 'Agents are never parties: signing keys belong to personas/groups; automation acts under, never as.',
  'M-14': 'Assertions violating the transition table are invalid and MUST be discarded.',
  'M-15': 'Retention decay: plaintext SHOULD be deleted, edge+assertion chains MUST be preserved. Personal-scope escrow MUST NOT exist; team-scope escrow MUST be protocol-visible.',
  'M-16': 'A device key MUST NOT be sole custodian of vault content keys.',
  'M-20':
    "A node MUST NOT advertise an act the transition table does not authorize the requesting persona to sign in the item's current state, and MUST NOT bind an advertised act to a tool call that produces no assertion. A client MUST NOT invent a tool binding for an act the node reports as unbound.",
} as const;

export type MustId = keyof typeof MUSTS;

export const MUST_IDS = Object.keys(MUSTS) as MustId[];
