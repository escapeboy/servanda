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
// every time, as the first line OF the frame rather than a line above it — a person who
// cannot tell their own promises from a sample has no reason to trust either, and a label
// printed once outside the frame is a label the renderer is free to scroll or clear away.
import { COPY, FixtureNodeClient, loadApp, makeFixture } from '@servanda/client-web';
import { openRegister } from '@servanda/client-local';
import { frame, handleKey, loadInk, sourceFor } from '@servanda/tui';

// Built by code point rather than written literally: an escape byte in a source file is a
// byte nobody can see in a diff.
const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J${ESC}[H`;

const now = new Date().toISOString();

const source = sourceFor(process.env);

let client;
let pending;
let banner;

if (source.kind === 'refuse') {
  process.stderr.write(source.message);
  process.exit(2);
}

if (source.kind === 'register') {
  const { dir, passphrase, persona } = source;
  let opened;
  try {
    opened = openRegister({ dir, passphrase, persona });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  client = opened.client;
  // §7 has no read path for the extraction-confirmation queue: `confirm` takes an id and
  // nothing hands one out (filed upstream). So the inbox is genuinely empty here rather than
  // borrowed from the sample — an empty queue is true, and a borrowed one is not.
  pending = { items: [] };
  banner = COPY.source.yours(dir, `${opened.personaId.slice(0, 8)}…`);
} else {
  // Built for the instant the frame is rendered at, not for the fixture's own default. The
  // two are the same parameter and were passed different values: the sample was composed
  // around 1 March 2026 and rendered against today's clock, so a person opening Servanda for
  // the first time met a brief dated five months ago in which every promise was 150-odd days
  // past its date and nothing was due today. A demonstration is a claim about what a register
  // looks like, and that one was a claim about an abandoned register.
  const fixture = makeFixture(24, now);
  client = new FixtureNodeClient(fixture);
  pending = { items: fixture.pending };
  banner = source.banner;
}

// The banner is part of the frame, not a line printed above it: Ink clears the whole terminal
// as soon as the frame outgrows the window, and a label written once was then gone for the
// rest of the session. Carried in the state, it is redrawn by whichever renderer is running.
let state = {
  app: await loadApp(client, { surface: 'brief', now, pending }),
  cursor: 0,
  quit: false,
  banner,
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
