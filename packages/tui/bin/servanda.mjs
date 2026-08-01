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
//
// Two SOURCES, too, and the difference matters more than the renderer does:
//
//   SERVANDA_VAULT + SERVANDA_PASSPHRASE set  →  your own register, out of your own vault
//   neither set                               →  a demonstration, on invented promises
//
// The demonstration exists because the surfaces were built before anything could serve them
// real data, and it is still the right thing to show someone who has no vault yet. What it
// must never do is look like a register. So the program says which one you are looking at,
// every time, in a line above the frame — a person who cannot tell their own promises from
// a sample has no reason to trust either.
import { FixtureNodeClient, loadApp, makeFixture } from '@servanda/client-web';
import { openRegister } from '@servanda/client-local';
import { frame, handleKey, loadInk } from '@servanda/tui';

// Built by code point rather than written literally: an escape byte in a source file is a
// byte nobody can see in a diff.
const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J${ESC}[H`;

const now = new Date().toISOString();

const dir = process.env['SERVANDA_VAULT'];
const passphrase = process.env['SERVANDA_PASSPHRASE'];
const wantsLocal = dir !== undefined;

let client;
let pending;
let banner;

if (wantsLocal) {
  if (passphrase === undefined) {
    process.stderr.write(
      'SERVANDA_VAULT is set but SERVANDA_PASSPHRASE is not. The vault is encrypted; a\n' +
        'register cannot be opened without it. Refusing to fall back to the demonstration,\n' +
        'because a sample shown where your promises were expected is worse than an error.\n',
    );
    process.exit(2);
  }
  let opened;
  try {
    opened = openRegister({ dir, passphrase, persona: process.env['SERVANDA_PERSONA'] });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  client = opened.client;
  // §7 has no read path for the extraction-confirmation queue: `confirm` takes an id and
  // nothing hands one out (filed upstream). So the inbox is genuinely empty here rather than
  // borrowed from the sample — an empty queue is true, and a borrowed one is not.
  pending = { items: [] };
  banner = `Your register · vault ${dir} · persona ${opened.personaId.slice(0, 8)}…`;
} else {
  const fixture = makeFixture();
  client = new FixtureNodeClient(fixture);
  pending = { items: fixture.pending };
  banner =
    'DEMONSTRATION — these promises are invented. Set SERVANDA_VAULT and SERVANDA_PASSPHRASE to read your own.';
}

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
  process.stdout.write(`${banner}\n`);
  runInk(ink, { initialState: state, onKey: step });
} else {
  if (wantsInk) {
    process.stdout.write('The rich terminal view is unavailable here. Showing the plain one.\n');
  }

  const draw = () => {
    process.stdout.write(CLEAR);
    process.stdout.write(`${banner}\n`);
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
