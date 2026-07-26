# @servanda/tui

The register as text, for engineers. Full parity with the web client through the same five §7 tools —
a different renderer, not a different product.

Same doctrine as `@servanda/client-web`: notary register, no exclamation marks, human vocabulary
(owe / waiting / closed), attention-market ordering only, verification level always shown and never
a name above its evidence (M-12).

Seal states render as text marks; verification level as degrees of relief. Terminal colour maps onto
Ink / Bone / Wax / Bronze, with Wax still reserved exclusively for the seal.

Gate GE scans this package's user-facing strings for forbidden protocol vocabulary alongside the web
client and the email brief — one vocabulary, three surfaces.

## Two renderers, one of them a wrapper

`frame.ts` turns the shared view model into lines. That is the renderer.

`ink.ts` + `ink/servanda-ink.mjs` draw those lines with Ink. The component layer knows nothing but
rows and keys; what a card says, what order things come in and which action leads are decided in the
shared view model, so the two paths cannot drift.

**Ink is declared but not installed.** `ink` and `react` are in this package's `dependencies` and the
workspace has not been installed since. Until `pnpm install` runs:

- `servanda` uses the plain-text renderer, as it always has;
- `servanda --ink` finds no Ink, prints one line saying so, and falls back;
- `loadInk()` returns `null`, and `packages/tui/ink/servanda-ink.mjs` has never been executed.

Nothing in this package claims Ink works. Once the two packages are present, `servanda --ink` runs
the component layer with no build step — it is written in plain `createElement`, not JSX.
