// The Ink component layer.
//
// A wrapper over `frame.ts`, not a rewrite: it renders exactly the rows `inkRows` produces
// and nothing else. What a card says, what order things come in and which action leads are
// decided above, in the shared view model; this file is not entitled to an opinion about
// any of them. Keys are handed back to the caller, which owns `handleKey` and the node
// client — so the Ink path and the text path answer to the same keys by construction.
//
// Written without JSX on purpose: no build step, no loader, no second toolchain. Node runs
// it as it stands the moment `ink` and `react` are present.
//
// Executed and verified: `ink` and `react` are installed, and `bin/servanda.mjs --ink` draws
// the register under a pty. The plain-text path remains the fallback when they are absent —
// `bin/servanda.mjs` says which renderer it used rather than pretending, and both take their
// lines from `frameLines`, so the two can never drift apart.
import { createElement as h, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { inkRows } from '../dist/index.js';

/** One row. The cursor marker is already in the text; weight is the only thing added. */
function Row({ row }) {
  return h(Text, { bold: row.focused }, row.text.length === 0 ? ' ' : row.text);
}

/** The frame: the same lines the plain renderer writes, one Ink row each. */
export function Frame({ state }) {
  return h(
    Box,
    { flexDirection: 'column' },
    inkRows(state).map((row) => h(Row, { key: row.key, row })),
  );
}

/**
 * The surface. `onKey(state, key)` is the caller's — it may be async, because switching
 * surface reloads through the five tools — and returns the next state, or null to quit.
 */
export function App({ initialState, onKey }) {
  const [state, setState] = useState(initialState);
  const { exit } = useApp();

  useInput((input, key) => {
    const pressed = key.tab
      ? key.shift
        ? '[Z'
        : '\t'
      : key.return
        ? '\r'
        : key.upArrow
          ? '[A'
          : key.downArrow
            ? '[B'
            : input;
    Promise.resolve(onKey(state, pressed)).then((next) => {
      if (next === null) exit();
      else setState(next);
    });
  });

  return h(Frame, { state });
}

/** Draws the surface with Ink. `runtime` is whatever `loadInk()` handed back. */
export function runInk(runtime, options) {
  return runtime.render(h(App, options));
}
