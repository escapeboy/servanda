import type { El } from './element.js';
import { walk } from './element.js';

/**
 * Full keyboard operation is a floor, not a feature — so it is checked, not asserted.
 *
 * The check is structural rather than behavioural: an action that lives on a `<button>` is
 * operable by keyboard because the platform makes it so, and an action that lives on a
 * `<div>` with a click handler is not, no matter how carefully the handler was written.
 * `pointerOnlyControls` finds the second kind. That is the bug this file exists to catch.
 */

/** Elements the platform focuses and activates from the keyboard with no help from us. */
const NATIVELY_OPERABLE = new Set(['button', 'input', 'select', 'textarea', 'summary']);

/** Keys that activate a focused control. */
export const ACTIVATION_KEYS = ['Enter', ' '] as const;

export interface FocusStop {
  readonly element: El;
  /** The action this stop performs, or null for pure navigation. */
  readonly actionId: string | null;
  /** What a screen reader announces. A control with no name is unusable, sighted or not. */
  readonly name: string;
}

function isFocusable(node: El): boolean {
  const tabIndex = node.attrs?.['tabindex'];
  if (typeof tabIndex === 'number' && tabIndex >= 0) return true;
  if (typeof tabIndex === 'string' && Number.parseInt(tabIndex, 10) >= 0) return true;
  if (node.tag === 'a') return typeof node.attrs?.['href'] === 'string';
  if (!NATIVELY_OPERABLE.has(node.tag)) return false;
  return node.attrs?.['disabled'] !== true;
}

export function accessibleName(node: El): string {
  const label = node.attrs?.['aria-label'];
  if (typeof label === 'string' && label.length > 0) return label;
  if (node.text !== undefined && node.text.length > 0) return node.text;
  for (const child of walk(node).slice(1)) {
    if (child.text !== undefined && child.text.length > 0) return child.text;
  }
  return '';
}

/** Document order is Tab order: nothing here uses a positive tabindex to reshuffle it. */
export function focusOrder(tree: El): FocusStop[] {
  const stops: FocusStop[] = [];
  for (const node of walk(tree)) {
    if (!isFocusable(node)) continue;
    const action = node.attrs?.['data-action'];
    stops.push({
      element: node,
      actionId: typeof action === 'string' ? action : null,
      name: accessibleName(node),
    });
  }
  return stops;
}

/**
 * Anything that carries an action but is not natively operable from the keyboard. A
 * non-empty result is a keyboard-only walkthrough that would dead-end, and gate GE fails on
 * it rather than reporting it.
 */
export function pointerOnlyControls(tree: El): El[] {
  return walk(tree).filter(
    (node) => typeof node.attrs?.['data-action'] === 'string' && !isFocusable(node),
  );
}

/** What pressing `key` on a focused stop does. Anything else does nothing. */
export function activate(stop: FocusStop, key: string): string | null {
  if (!(ACTIVATION_KEYS as readonly string[]).includes(key)) return null;
  return stop.actionId;
}

/** Tab / Shift+Tab, wrapping — the walkthrough the gate performs. */
export function nextStop(stops: readonly FocusStop[], index: number, shift = false): number {
  if (stops.length === 0) return -1;
  return shift ? (index - 1 + stops.length) % stops.length : (index + 1) % stops.length;
}
