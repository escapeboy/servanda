#!/usr/bin/env node
// The terminal surface. Reads keys, draws frames, and reaches the register through the
// five tools and nothing else.
//
// This entry point is the only place that touches a clock or a terminal; everything it
// calls is a pure function of state, which is what makes the surface testable.
//
// Two renderers, one of them a wrapper over the other. `--ink` asks for the rich one; if
// `ink` and `react` are not present the plain-text path runs instead and the program says
// so in one line rather than pretending. Both draw the same lines, because both take them
// from `frameLines`.
import { FixtureNodeClient, loadApp, makeFixture } from '@servanda/client-web';
import { frame, handleKey, loadInk } from '@servanda/tui';

// Built by code point rather than written literally: an escape byte in a source file is a
// byte nobody can see in a diff.
const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J${ESC}[H`;

const now = new Date().toISOString();
const fixture = makeFixture();
const client = new FixtureNodeClient(fixture);
const pending = { items: fixture.pending };

let state = {
  app: await loadApp(client, { surface: 'brief', now, pending }),
  cursor: 0,
  quit: false,
};

/** One key, applied. Returns the next state, or null when the answer is to stop. */
const step = async (current, key) => {
  const result = handleKey(current, key);
  if (result.state.quit) return null;
  if (result.surface === null) return result.state;
  return {
    ...result.state,
    app: await loadApp(client, { surface: result.surface, now, pending }),
    cursor: 0,
  };
};

const wantsInk = process.argv.includes('--ink');
const ink = wantsInk ? await loadInk() : null;

if (ink !== null) {
  const { runInk } = await import('../ink/servanda-ink.mjs');
  runInk(ink, { initialState: state, onKey: step });
} else {
  if (wantsInk) {
    process.stdout.write('The rich terminal view is unavailable here. Showing the plain one.\n');
  }

  const draw = () => {
    process.stdout.write(CLEAR);
    process.stdout.write(`${frame(state)}\n`);
  };

  draw();

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  for await (const key of process.stdin) {
    const next = await step(state, key);
    if (next === null) break;
    state = next;
    draw();
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}
