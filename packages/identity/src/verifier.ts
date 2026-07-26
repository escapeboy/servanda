import type { AnchorResolution, Clock } from './anchor.js';
import { DomainAnchorResolver, systemClock } from './anchor.js';
import type { AttestationVerdict } from './attestation.js';
import { verifyAttestation } from './attestation.js';
import type { BindingProofObservation, BindingProofVerdict } from './binding-proof.js';
import { verifyBindingProof } from './binding-proof.js';
import type { VerifiedIdentity } from './ladder.js';
import { bindingLevel } from './ladder.js';

/**
 * The one call a client makes: raw evidence in, a graded identity out.
 *
 * §1.5 requires the anchor be checked *at signature-verification time*, so the anchor lookup
 * happens here rather than being a field the caller may forget to refresh — the resolver's
 * cache is what keeps that from being expensive, and the cache reads the injected clock.
 */
export interface IdentityVerifierOptions {
  readonly resolver?: DomainAnchorResolver;
  readonly clock?: Clock;
}

export interface VerifyIdentityInput {
  /** The persona or group key being verified. */
  readonly subject: string;
  /** §1.6 level 1 evidence: how many prior confirmed edges this node holds with this key. */
  readonly priorConfirmedEdges?: number;
  /** Candidate org attestations. The first that verifies is used; the rest become downgrades. */
  readonly attestations?: readonly unknown[];
  /** Revocations the node holds, from any org. */
  readonly revocations?: readonly unknown[];
  /** §1.3 offboarding: the time of the signature being verified. */
  readonly signedAt?: Date | null;
  /** The domain to check for the attesting org's anchor (§1.5). */
  readonly orgDomain?: string | null;
  /** A binding proof plus where it was actually observed (§1.6 ext). */
  readonly bindingProof?: { readonly proof: unknown; readonly observed: BindingProofObservation } | null;
}

export class IdentityVerifier {
  readonly #resolver: DomainAnchorResolver;
  readonly #clock: Clock;

  constructor(options: IdentityVerifierOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#resolver = options.resolver ?? new DomainAnchorResolver({ clock: this.#clock });
  }

  async verify(input: VerifyIdentityInput): Promise<VerifiedIdentity> {
    const now = this.#clock.now();

    let attestation: AttestationVerdict | null = null;
    for (const candidate of input.attestations ?? []) {
      const verdict = verifyAttestation(candidate, {
        now,
        signedAt: input.signedAt ?? null,
        subject: input.subject,
        revocations: input.revocations,
      });
      if (verdict.ok) {
        attestation = verdict;
        break;
      }
      // Keep the first failure so the client can say *why* it is not attested.
      attestation ??= verdict;
    }

    let anchor: AnchorResolution | null = null;
    if (input.orgDomain != null && input.orgDomain !== '') {
      anchor = await this.#resolver.resolve(input.orgDomain);
    }

    let bindingProof: BindingProofVerdict | null = null;
    if (input.bindingProof != null) {
      bindingProof = verifyBindingProof(input.bindingProof.proof, {
        observed: input.bindingProof.observed,
        persona: input.subject,
      });
    }

    return bindingLevel({
      subject: input.subject,
      priorConfirmedEdges: input.priorConfirmedEdges ?? 0,
      attestation,
      anchor,
      bindingProof,
    });
  }
}
