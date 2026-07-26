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
 */

export interface MountOptions {
  readonly onAction: (actionId: string) => void;
  readonly onSurface: (surface: SurfaceId) => void;
}

function toDom(node: El, doc: Document): Node {
  const element = doc.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value === false) continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }
  if (node.text !== undefined) element.textContent = node.text;
  else for (const child of node.children ?? []) element.appendChild(toDom(child, doc));
  return element;
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
  root.replaceChildren(toDom(tree, doc));
  // Re-render replaces the children, not the root, so the delegated listener is attached
  // exactly once however many times the surface is redrawn.
  if (root.hasAttribute('data-servanda-bound')) return;
  root.setAttribute('data-servanda-bound', '');
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest('[data-action],[data-surface]');
    if (control === null) return;
    const action = control.getAttribute('data-action');
    if (action !== null) {
      options.onAction(action);
      return;
    }
    const surface = control.getAttribute('data-surface');
    if (surface !== null) options.onSurface(surface as SurfaceId);
  });
}
