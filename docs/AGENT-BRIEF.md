# Implementation brief — shared ground rules

Every stream of this implementation follows these rules. They are not style preferences; several
of them are the difference between a conforming node and a non-conforming one.

## Sources of truth, in priority order

1. **Svod MCP → `projects/servanda/spec/00..09`** — NORMATIVE. Read the sections your stream
   touches before writing code. Every §8 MUST is binding.
2. **Svod MCP → `projects/servanda/docs/*`** — rationale. `ui-design.md` governs all UI
   decisions. ADRs 0001–0014 are accepted decisions; ADR-0015 (in-repo) records the language choice.
3. **`vendor/vectors/`** — the conformance oracle, vendored from
   github.com/escapeboy/servanda-protocol. Read `vendor/vectors/README.md` first: it documents
   eight interpretations the generator had to make where the spec is under-specified.

**If spec and docs conflict, spec wins.** If the spec is ambiguous or contradictory: do NOT
resolve it silently. Implement the narrowest reading, comment the decision at the code site, and
report it — the orchestrator files it as an issue in servanda-protocol. Seventeen such issues are
already filed; check `gh issue list -R escapeboy/servanda-protocol` before filing a duplicate.

## Constitution in code

Every M-x has a **named test**. A test file that covers a MUST names it in the describe block:

```ts
describe('M-14: assertions violating the transition table are discarded', () => { ... })
```

`MUSTS` and `MUST_IDS` in `@servanda/types` are the list, as data. A PR that breaks a MUST cannot
merge — that is what the gates enforce.

## What already exists (S0, gate G0 green)

- **`@servanda/crypto`** — `canonicalize` / `canonicalBytes` (RFC 8785), `sha256Hex`,
  `hashCanonical`, `toHex` / `fromHex` / `utf8` / `concatBytes`, `derivePersona` / `derivePath`
  (SLIP-0010 `m/7391'/{i}'`), `mnemonicToSeed`, `signObject` / `verifyObject` / `withSignature` /
  `signingPreimage` / `unsigned`, `commitmentHash` (§3.2 five fields), `edgeId` (§4.1),
  content-key wrapping (`sealContentKey`, `wrapForPassphrase`, `wrapForDevice`,
  `unwrapWithPassphrase`, `unwrapWithDevice`, `encryptContent`, `decryptContent`, `assertM16`),
  and the §6.3 blind courier (`sealToPersona` / `openSealed`).
- **`@servanda/types`** — every spec object as a zod schema plus its inferred TS type, the §7 node
  surface I/O schemas, `MUSTS`, `TERMINAL_STATES`, `RejectionReason`, `EffectiveState`.

**Do not reimplement any of this.** Import it. If something is missing, add it to the right
package rather than writing a local copy.

One layering rule you will hit: `Assertion.state` uses `WireAssertionState`, which **admits
`open`**, while `AssertableState` does not. This is deliberate. A peer can put `open` in an
assertion and §4.3 requires the node to *discard* it with the reason
`implicit-transition-not-assertable`. If the parser rejected `open`, the node could not report
that reason. **Syntax is the parser's job; assertability is the transition table's.**

## Working agreement

- TypeScript strict, ESM, Node 22+. `verbatimModuleSyntax` is on: use `import type` for types.
- Relative imports inside a package end in `.js` (NodeNext resolution).
- Tests are `vitest`, in `packages/<pkg>/test/*.test.ts`. The root `vitest.config.ts` picks them up.
- New package? Copy the `package.json` / `tsconfig.json` shape from `packages/types`, and add the
  workspace dep as `"@servanda/types": "workspace:*"`.
- Conventional commits. Commit as you go; do not leave everything to one commit at the end.
- **Report failures honestly.** If your gate does not pass, say so with the output. Never
  weaken a test, skip a case, or narrow a gate's scope to manufacture a green result. A stream
  that reports "gate green" when it is not is worse than one that reports it is blocked.

## Boundaries

- **No deploys, no publishing, no external services** beyond the Anthropic API for extraction.
- **Executors touch only fixture repos.** Never the user's real projects. Never `~/htdocs/*`
  other than this repo and its `fixtures/`.
- Anything that looks like a *design change* to the protocol goes to servanda-protocol issues,
  never into code.
- Do not `git push` to `main`. Work on your branch; the orchestrator merges through the gate.
