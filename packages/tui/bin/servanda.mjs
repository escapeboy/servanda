#!/usr/bin/env node
// The terminal surface. Reads keys, draws frames, and reaches the register through the
// five tools and nothing else.
//
// This entry point is the only place that touches a clock or a terminal; everything it
// calls is a pure function of state, which is what makes the surface testable.
import { FixtureNodeClient, loadApp, makeFixture } from '@servanda/client-web';
import { frame, handleKey } from '@servanda/tui';

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

const draw = () => {
  process.stdout.write(CLEAR);
  process.stdout.write(`${frame(state)}\n`);
};

draw();

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
for await (const key of process.stdin) {
  const result = handleKey(state, key);
  state = result.state;
  if (result.surface !== null) {
    state = {
      ...state,
      app: await loadApp(client, { surface: result.surface, now, pending }),
      cursor: 0,
    };
  }
  if (state.quit) break;
  draw();
}

if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.exit(0);
