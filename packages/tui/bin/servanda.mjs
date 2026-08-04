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
import { frame, handleKey, loadInk, parseArgs, runCommand, sourceFor, USAGE, UsageError } from '@servanda/tui';

// The write half, before anything is rendered.
//
// `servanda` opened a register and nothing shipped could put a promise in one: `commit` had three
// callers — a library method, an MCP tool, and a gesture runner nothing calls — so a person
// needed an assistant speaking MCP or a model API key to record anything. §0's base rule is that
// this works with no network, no server and no second participant; it did, and offered no way in.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
{
  let parsed = null;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (parsed !== null) {
    const src = sourceFor(process.env);
    if (src.kind !== 'register') {
      // Writing into a demonstration would be the one thing worse than not writing at all: a
      // promise recorded nowhere, reported as recorded.
      process.stderr.write(
        'Writing needs your own register. Set SERVANDA_VAULT and SERVANDA_PASSPHRASE.\n',
      );
      process.exit(2);
    }
    const { openRegister: open } = await import('@servanda/client-local');
    const opened = open({ dir: src.dir, passphrase: src.passphrase, persona: src.persona });
    try {
      // The vault's own labels, passed as a lookup so the message can be specific without this
      // module being able to open anything.
      const labelOf = (label) => {
        for (const id of opened.vault.listPersonaIds()) {
          if (opened.vault.getPersona(id).label === label) return id;
        }
        return null;
      };
      process.stdout.write(`${await runCommand(parsed, opened.client, labelOf)}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
}

// Built by code point rather than written literally: an escape byte in a source file is a
// byte nobody can see in a diff.
const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J${ESC}[H`;

const now = new Date().toISOString();

const source = sourceFor(process.env);

let client;
let pending;
let banner;
let vaultStrength;
let delivery;

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
  // `pending` is deliberately NOT set for a real register.
  //
  // It used to be `{ items: [] }`, with a comment explaining that §7 had no read path for the
  // extraction-confirmation queue. That was true when it was written and stopped being true when
  // `view: "pending"` learned to serve both halves of its sentence — and nothing noticed, because
  // an explicit empty value overrides the fetch just as effectively as a missing feature. The
  // inbox stayed empty for a reason that no longer existed.
  //
  // Leaving it undefined is what makes `loadApp` walk the view. That is the difference between
  // "there is nothing to confirm" and "nothing was asked".
  vaultStrength = opened.vaultStrength;
  delivery = opened.delivery;
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
  // No vault behind a demonstration, so no claim about one. An invented security
  // notice is worse than an invented promise: the promise is labelled a sample and
  // the notice would be read as a fact about the reader's own machine.
  vaultStrength = undefined;
  delivery = undefined;
  banner = source.banner;
}

// One place that says what `loadApp` is given, so the two call sites below cannot drift — the
// first render and every keypress must show the same register, and they were separately
// spelled-out argument lists.
const opts = () => ({
  ...(pending === undefined ? {} : { pending }),
  ...(vaultStrength === undefined ? {} : { vault: vaultStrength }),
  ...(delivery === undefined ? {} : { delivery }),
});

// The banner is part of the frame, not a line printed above it: Ink clears the whole terminal
// as soon as the frame outgrows the window, and a label written once was then gone for the
// rest of the session. Carried in the state, it is redrawn by whichever renderer is running.
let state = {
  app: await loadApp(client, { surface: 'brief', now, ...opts() }),
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
    app: await loadApp(client, { surface: result.surface, now, ...opts() }),
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
