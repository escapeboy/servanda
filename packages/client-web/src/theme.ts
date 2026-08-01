/**
 * The palette and type, as a stylesheet string.
 *
 * Four rules from the doctrine are enforced here and checked by gate GE:
 *
 *  - **Light is the default.** Bone on Ink is a register, not a dashboard. Dark mode is the
 *    inversion onto Ink, nothing more.
 *  - **Wax is reserved exclusively for the seal.** `#8C2F1B` appears in this file only
 *    inside `.seal` rules, and it is deliberately not a custom property: a token in `:root`
 *    is an invitation to spend it somewhere else.
 *  - **No gradients, no glows.** No `linear-gradient`, no `box-shadow` spread of light.
 *  - **No webfont is fetched.** The three faces are named and the stack degrades to what
 *    the machine already has. A client that must render offline cannot start by asking the
 *    network for a font.
 */

export const INK = '#14120E';
export const BONE = '#F7F4EC';
export const BRONZE = '#C9A86A';
/** Named for documentation only. The value is written literally in the seal rules below. */
export const WAX_RESERVED_FOR_SEAL = '#8C2F1B';

export const THEME_CSS = `
:root {
  --ink: ${INK};
  --bone: ${BONE};
  --bronze: ${BRONZE};
  --green: #4C6B4F;
  --amber: #A8792B;
  --rule: rgba(20, 18, 14, 0.14);
  --display: Spectral, Iowan Old Style, Palatino, Georgia, serif;
  --ui: Public Sans, Helvetica Neue, Helvetica, Arial, sans-serif;
  --mono: JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}

.servanda {
  background: var(--bone);
  color: var(--ink);
  font-family: var(--ui);
  font-size: 16px;
  line-height: 1.5;
  margin: 0 auto;
  max-width: 46rem;
  padding: 2rem 1.25rem 4rem;
}

.servanda h1,
.servanda h2 {
  font-family: var(--display);
  font-weight: 500;
  letter-spacing: 0.01em;
  margin: 2rem 0 0.25rem;
}

.servanda h1 { font-size: 1.75rem; }
.servanda h2 { font-size: 1.25rem; }

nav {
  border-bottom: 1px solid var(--rule);
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding-bottom: 0.5rem;
}

.nav-item {
  background: none;
  border: 1px solid transparent;
  border-radius: 2px;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0.35rem 0.6rem;
}

.nav-current { border-color: var(--bronze); }

.cards { list-style: none; margin: 0; padding: 0; }

.card {
  border-bottom: 1px solid var(--rule);
  padding: 1rem 0;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.action {
  background: none;
  border: 1px solid var(--rule);
  border-radius: 2px;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0.35rem 0.75rem;
}

.action-primary { border-color: var(--ink); font-weight: 600; }

.action:focus-visible,
.nav-item:focus-visible {
  outline: 2px solid var(--bronze);
  outline-offset: 2px;
}

.what { font-family: var(--display); font-size: 1.0625rem; margin: 0 0 0.25rem; }

.with {
  align-items: baseline;
  display: flex;
  gap: 0.5rem;
  margin: 0 0 0.15rem;
}

.party { font-weight: 500; }
.party-key { font-family: var(--mono); font-size: 0.875rem; }

.trust { color: var(--bronze); font-size: 0.8125rem; }
.relief-flat { color: rgba(20, 18, 14, 0.55); }

.consequence { font-size: 0.9375rem; margin: 0; }
.tone-passed { color: var(--amber); }
.tone-settled { color: var(--green); }

.empty { color: rgba(20, 18, 14, 0.6); font-style: italic; margin: 0.5rem 0; }
.generated,
.below-the-line { color: rgba(20, 18, 14, 0.6); font-size: 0.875rem; margin: 0.25rem 0; }

.blocks { color: rgba(20, 18, 14, 0.6); font-size: 0.875rem; margin: 0.15rem 0 0; }
.outcome { font-family: var(--display); font-size: 1.125rem; margin: 0.5rem 0 1rem; }

/* Hashes, keys and timestamps. Evidence is set in mono and shown whole, never truncated
   by the stylesheet — a certificate nobody can read the fingerprint on proves nothing. */
.hash {
  font-family: var(--mono);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.fingerprint { margin: 0.25rem 0; }

.parties,
.dates,
.chain,
.classes,
.rungs,
.steps,
.recovery-words { list-style: none; margin: 0; padding: 0; }

.party-pair { display: inline-flex; gap: 0.4rem; align-items: baseline; }

.party-row,
.date-row,
.chain-step {
  border-bottom: 1px solid var(--rule);
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.party-role,
.date-label { color: rgba(20, 18, 14, 0.6); font-size: 0.875rem; min-width: 8rem; }
.chain-evidence { color: var(--bronze); font-size: 0.8125rem; }

.step { border-bottom: 1px solid var(--rule); padding: 1rem 0; }
.step-done { opacity: 0.6; }
.recovery { border-top: 1px solid var(--rule); margin-top: 2rem; }
.recovery-words { columns: 2; font-family: var(--mono); margin: 0.5rem 0; }

.work-class { border-bottom: 1px solid var(--rule); padding: 0.75rem 0; }
.work-class h3 { font-family: var(--ui); font-size: 1rem; font-weight: 600; margin: 0 0 0.35rem; }

/* A rung is a reading, not a control: nothing here is a button and nothing is focusable. */
.rung {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.9375rem;
  padding: 0.2rem 0;
}
.rung-state { color: rgba(20, 18, 14, 0.6); font-size: 0.8125rem; }
.rung-explains { color: rgba(20, 18, 14, 0.6); font-size: 0.8125rem; }
.rung-earned .rung-label { color: var(--green); }
.rung-standing .rung-label { font-weight: 600; }
.rung-locked,
.rung-closed { color: rgba(20, 18, 14, 0.55); }

/* The seal, and the only place wax is spent. Degrees of relief carry the evidence level. */
.seal {
  border: 1px solid #8C2F1B;
  border-radius: 50%;
  display: inline-block;
  flex: none;
  height: 0.75rem;
  width: 0.75rem;
}
.seal-unsealed { border-color: var(--rule); }
.seal-half { border-style: dashed; border-color: #8C2F1B; }
.seal-joined { background: #8C2F1B; }
.seal-marked { background: #8C2F1B; border-width: 2px; }
.seal-cracked { background: #8C2F1B; border-style: dotted; }
.seal-arrow { background: #8C2F1B; border-radius: 50% 50% 50% 0; }
/* Struck in ladder order (§1.6: 0 < 1 < ext < 2 < 3), so the wax never says more than the
   evidence. ext is a deeper inset than continuity and still a 1px rim: a binding proof is
   more than "the same key as before" and less than a third party staking its own key. It was
   a 3px double rim here — the deepest mark on the page, above an attestation. */
.seal.relief-continuity { box-shadow: inset 0 0 0 1px var(--bone); }
.seal.relief-external { box-shadow: inset 0 0 0 2px var(--bone); }
.seal.relief-attested { border-width: 2px; }
.seal.relief-domain { border-width: 3px; }

@media (prefers-color-scheme: dark) {
  :root {
    --rule: rgba(247, 244, 236, 0.18);
  }
  .servanda { background: var(--ink); color: var(--bone); }
  .action-primary { border-color: var(--bone); }
  .relief-flat { color: rgba(247, 244, 236, 0.55); }
  .empty,
  .generated,
  .blocks,
  .party-role,
  .date-label,
  .rung-state,
  .rung-explains,
  .below-the-line { color: rgba(247, 244, 236, 0.6); }
  .rung-locked,
  .rung-closed { color: rgba(247, 244, 236, 0.55); }
  .seal.relief-continuity { box-shadow: inset 0 0 0 1px var(--ink); }
  .seal.relief-external { box-shadow: inset 0 0 0 2px var(--ink); }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none; transition: none; }
}
`;
