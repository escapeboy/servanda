import { describe, expect, it } from 'vitest';
import type { El } from '../src/index.js';
import { appEl, renderToHtml } from '../src/index.js';
import type { ControlLike, DocumentLike, ElementLike, Intent, MountOptions } from '../src/mount.js';
import { applyIntent, intentOf, toDom } from '../src/mount.js';
import { app } from './fixture.js';

/**
 * The DOM adapter.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — said plainly, because the difference matters.
 * There is no DOM in this workspace and this stream may not install one, so these tests run
 * `toDom` against the minimal document double below and check the *mapping* it performs:
 * which elements are created, which attributes are set, where text lands. That is real
 * coverage of the code that has decisions in it.
 *
 * It is NOT proof that a browser behaves as this double does. `mount` itself — the six
 * lines that call `replaceChildren`, `hasAttribute` and `addEventListener` — remains
 * untested, and is deliberately kept that small for exactly that reason. Nothing here
 * claims otherwise.
 */

interface FakeElement extends ElementLike {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: FakeElement[];
  textContent: string | null;
}

function fakeDocument(): DocumentLike & { created: FakeElement[] } {
  const created: FakeElement[] = [];
  return {
    created,
    createElement(tag: string): FakeElement {
      const element: FakeElement = {
        tag,
        attrs: {},
        children: [],
        textContent: null,
        setAttribute(name, value) {
          element.attrs[name] = value;
        },
        appendChild(child) {
          element.children.push(child as unknown as FakeElement);
          return child;
        },
      };
      created.push(element);
      return element;
    },
  };
}

function control(attrs: Record<string, string>): ControlLike {
  return { getAttribute: (name) => attrs[name] ?? null };
}

describe('the element tree becomes document nodes, attribute for attribute', () => {
  it('creates one node per element, with the same tags', async () => {
    const tree = appEl(await app('owe'));
    const doc = fakeDocument();
    const root = toDom(tree, doc) as FakeElement;
    expect(root.tag).toBe('main');
    expect(root.attrs['id']).toBe('servanda');
    expect(doc.created.length).toBeGreaterThan(20);
  });

  it('puts text where the tree puts text, and never as a child node', () => {
    const doc = fakeDocument();
    const node = toDom({ tag: 'p', attrs: { class: 'what' }, text: 'Send the quote' }, doc) as FakeElement;
    expect(node.textContent).toBe('Send the quote');
    expect(node.children).toEqual([]);
  });

  it('treats true and false attributes exactly as the serialiser does', () => {
    const doc = fakeDocument();
    const tree: El = {
      tag: 'button',
      attrs: { type: 'button', disabled: true, 'aria-current': false, tabindex: 0 },
    };
    const node = toDom(tree, doc) as FakeElement;
    expect(node.attrs).toEqual({ type: 'button', disabled: '', tabindex: '0' });
    // The same decisions the HTML serialiser makes, so the two cannot drift.
    const html = renderToHtml(tree);
    expect(html).toContain(' disabled');
    expect(html).not.toContain('aria-current');
    expect(html).toContain('tabindex="0"');
  });

  it('nests children in document order', () => {
    const doc = fakeDocument();
    const node = toDom(
      {
        tag: 'ul',
        attrs: {},
        children: [
          { tag: 'li', attrs: {}, text: 'one' },
          { tag: 'li', attrs: {}, text: 'two' },
        ],
      },
      doc,
    ) as FakeElement;
    expect(node.children.map((c) => c.textContent)).toEqual(['one', 'two']);
  });

  it('escapes nothing, because a document node is not a string', () => {
    const doc = fakeDocument();
    const node = toDom({ tag: 'p', attrs: {}, text: '<script>alert(1)</script>' }, doc) as FakeElement;
    // Set as text content, so markup in a person's own words is inert by construction.
    expect(node.textContent).toBe('<script>alert(1)</script>');
    expect(node.children).toEqual([]);
  });
});

describe('a click is resolved to an intent, and an intent to a handler', () => {
  it('reads an action off a control', () => {
    expect(intentOf(control({ 'data-action': 'item-1:done' }))).toEqual({
      kind: 'action',
      id: 'item-1:done',
    });
  });

  it('reads a surface off a control', () => {
    expect(intentOf(control({ 'data-surface': 'inbox' }))).toEqual({ kind: 'surface', id: 'inbox' });
  });

  it('prefers the action when a control somehow carries both', () => {
    expect(intentOf(control({ 'data-action': 'a', 'data-surface': 'inbox' }))?.kind).toBe('action');
  });

  it('resolves a click on nothing to nothing', () => {
    expect(intentOf(null)).toBeNull();
    expect(intentOf(control({ class: 'card' }))).toBeNull();
  });

  it('routes each intent to exactly one handler, and null to neither', () => {
    const actions: string[] = [];
    const surfaces: string[] = [];
    const options: MountOptions = {
      onAction: (id) => actions.push(id),
      onSurface: (id) => surfaces.push(id),
    };
    const intents: (Intent | null)[] = [
      { kind: 'action', id: 'x:done' },
      { kind: 'surface', id: 'team' },
      null,
    ];
    for (const intent of intents) applyIntent(intent, options);
    expect(actions).toEqual(['x:done']);
    expect(surfaces).toEqual(['team']);
  });

  it('reaches every action on every surface through the one path a click takes', async () => {
    // The delegated listener resolves a control to an intent and hands it on. Feeding it
    // every control the surface renders proves the wiring covers all of them.
    const seen: string[] = [];
    const options: MountOptions = { onAction: (id) => seen.push(id), onSurface: () => {} };
    const view = await app('inbox');
    for (const node of walkTree(appEl(view))) {
      const id = node.attrs?.['data-action'];
      if (typeof id !== 'string') continue;
      applyIntent(intentOf(control({ 'data-action': id })), options);
    }
    expect(seen).toEqual(view.inbox.cards.flatMap((c) => c.actions.map((a) => a.id)));
  });
});

function walkTree(node: El): El[] {
  return [node, ...(node.children ?? []).flatMap(walkTree)];
}
