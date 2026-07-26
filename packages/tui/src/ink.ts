import type { FrameState } from './frame.js';
import { frameLines } from './frame.js';

/**
 * The Ink layer, as a wrapper over `frame.ts` rather than a second renderer.
 *
 * The rule this file exists to keep: the terminal has exactly one renderer, and it is the
 * one in `frame.ts` that turns the shared view model into lines. Ink draws those lines. It
 * does not decide what a card says, what order things come in, or which action leads —
 * those are the shared contract in `@servanda/client-web`, and a component tree that
 * reached past this boundary to the view model would be a second terminal surface free to
 * drift from the first.
 *
 * STATUS, stated plainly: `ink` and `react` are declared in this package's `package.json`
 * but are NOT installed in this workspace — this stream may not run an installer. So
 * `loadInk` returns null here, `bin/servanda.mjs` keeps using the plain-text path, and the
 * component layer in `../ink/servanda-ink.mjs` is written but has not been executed. It is
 * written without JSX, in plain `createElement` calls, so that it needs no build step and
 * runs the moment the two packages are present. Nothing in this file claims Ink works.
 */

export interface InkRow {
  readonly key: string;
  readonly text: string;
  /** Whether the cursor is on this row. A display hint; the marker is already in the text. */
  readonly focused: boolean;
}

/** The cursor marker `frame.ts` writes. Ink reads it rather than recomputing focus. */
export const CURSOR_MARKER = '>';

export function inkRows(state: FrameState): InkRow[] {
  return frameLines(state).map((text, index) => ({
    key: `row-${index}`,
    text,
    focused: text.trimStart().startsWith(CURSOR_MARKER) || text.includes(`${CURSOR_MARKER} [`),
  }));
}

/** The sliver of Ink this wrapper uses. Structural, so nothing here imports the package. */
export interface InkRuntime {
  readonly render: (node: unknown) => { unmount: () => void };
}

/**
 * Imports a package that may not be there, and answers null rather than throwing when it
 * is not. Separated out and exported so the fallback path is testable without depending on
 * whether a given package happens to be installed today.
 */
export async function loadOptional(specifier: string): Promise<unknown | null> {
  try {
    return (await import(specifier)) as unknown;
  } catch {
    return null;
  }
}

export async function loadInk(): Promise<InkRuntime | null> {
  const mod = await loadOptional('ink');
  if (mod === null) return null;
  const render = (mod as { render?: unknown }).render;
  return typeof render === 'function' ? (mod as InkRuntime) : null;
}

/** Whether the rich renderer can run at all, for a caller that wants to say so honestly. */
export async function inkAvailable(): Promise<boolean> {
  return (await loadInk()) !== null;
}
