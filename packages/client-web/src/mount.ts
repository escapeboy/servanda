import type { El } from './element.js';
import type { SurfaceId } from './render.js';
import { THEME_CSS } from './theme.js';

/**
 * Mounting into a real document. Browser-only; every other module in this package is
 * environment-free so the surface can be built and checked without one.
 *
 * The event wiring is one delegated `click` listener, deliberately. A native `<button>`
 * fires `click` when it is pressed with Enter or with Space, so pointer and keyboard reach
 * the same code by the same path — there is no second, weaker keyboard route to fall out of
 * date. That is why `pointerOnlyControls` is a hard failure rather than a lint.
 *
 * TESTABILITY (deliberate structure, reported): there is no DOM in this workspace and this
 * stream may not install one, so this file is arranged so that everything carrying a
 * decision — building elements, working out what a click meant, routing it — is a pure
 * function over the narrow structural types below, and `mount` itself is wiring with no
 * branch of its own beyond the bind-once guard. The tests exercise the pure parts against a
 * minimal stand-in document. What they therefore do NOT prove is that a real browser
 * behaves as the stand-in does: that is the honest limit of testing a DOM adapter with no
 * DOM, and it is why the untested remainder is kept to the few lines of `mount`.
 */

/** The parts of an element this module writes to. A real `Element` satisfies it. */
export interface ElementLike {
  setAttribute(name: string, value: string): void;
  appendChild(child: never): unknown;
  textContent: string | null;
}

/** The part of a document this module reads. A real `Document` satisfies it. */
export interface DocumentLike {
  createElement(tag: string): ElementLike;
}

export interface MountOptions {
  readonly onAction: (actionId: string) => void;
  readonly onSurface: (surface: SurfaceId) => void;
}

/**
 * Element tree → document nodes. A `false` attribute is dropped and `true` becomes the bare
 * attribute, matching `renderToHtml` exactly, so the browser and the serialiser cannot
 * disagree about what an attribute means.
 */
export function toDom(node: El, doc: DocumentLike): ElementLike {
  const element = doc.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value === false) continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }
  if (node.text !== undefined) element.textContent = node.text;
  else for (const child of node.children ?? []) element.appendChild(toDom(child, doc) as never);
  return element;
}

/** What a click meant, as data. Null when it landed on nothing that acts. */
export type Intent =
  | { readonly kind: 'action'; readonly id: string }
  | { readonly kind: 'surface'; readonly id: SurfaceId };

/** The two attributes the delegated listener reads, from whatever it was handed. */
export interface ControlLike {
  getAttribute(name: string): string | null;
}

export function intentOf(control: ControlLike | null): Intent | null {
  if (control === null) return null;
  const action = control.getAttribute('data-action');
  if (action !== null) return { kind: 'action', id: action };
  const surface = control.getAttribute('data-surface');
  if (surface !== null) return { kind: 'surface', id: surface as SurfaceId };
  return null;
}

/** Routes an intent to the caller's handlers. Pure dispatch, no document involved. */
export function applyIntent(intent: Intent | null, options: MountOptions): void {
  if (intent === null) return;
  if (intent.kind === 'action') options.onAction(intent.id);
  else options.onSurface(intent.id);
}

export function installTheme(doc: Document): void {
  if (doc.getElementById('servanda-theme') !== null) return;
  const style = doc.createElement('style');
  style.id = 'servanda-theme';
  style.textContent = THEME_CSS;
  doc.head.appendChild(style);
}

export function mount(root: Element, tree: El, options: MountOptions): void {
  const doc = root.ownerDocument;
  installTheme(doc);
  root.replaceChildren(toDom(tree, doc) as unknown as Node);
  // Re-render replaces the children, not the root, so the delegated listener is attached
  // exactly once however many times the surface is redrawn.
  if (root.hasAttribute('data-servanda-bound')) return;
  root.setAttribute('data-servanda-bound', '');
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    applyIntent(intentOf(target.closest('[data-action],[data-surface]')), options);
  });
}
