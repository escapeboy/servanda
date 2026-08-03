#!/usr/bin/env node
// Claude Code session hook. Register it per-event in settings.json, e.g.
//
//   { "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
//       "command": "servanda-cc-hook" } ] } ] } }
//
// Environment (registration is where the persona binding happens — §2 / M-5):
//   SERVANDA_PERSONA      required, hex ed25519 persona id
//   SERVANDA_ENVELOPE_LOG required, path to a regular file to append NDJSON envelopes to
//
// This process writes NOTHING to stdout. A hook's stdout is fed back into the session, so
// echoing envelopes there would push observed content into the model's context — the exact
// inversion M-6 forbids. Failures are silent on stdout and non-fatal to the session.
//
// Two things carry that guarantee, and neither is the absence of a `console.log`:
//
//   1. The exit code is 0 on every path, including every failure. Claude Code feeds a hook's
//      stderr back to the model only on exit 2; on 0 it goes to the debug log. The diagnostics
//      below are safe *because* of the exit code, so the two must be read together.
//   2. The log target is checked to be a regular file. `SERVANDA_ENVELOPE_LOG` names a path,
//      and on every Unix this process's own stdout is reachable as one — `/dev/stdout`,
//      `/dev/fd/1`. Pointed there, the hook prints every envelope it builds, verbatim prompt
//      and all, straight into the model's context. "Prints nothing" is a property of the
//      destination, not of the calls made here.
import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ClaudeCodeConnector } from '../dist/index.js';

/** Never stdout. See (1) above for why stderr is the honest channel and stdout never is. */
const note = (message) => process.stderr.write(`servanda-cc-hook: ${message}\n`);

/**
 * Append one NDJSON block to `path`, creating it owner-only.
 *
 * The log is the richest plaintext record of a person's working life on the machine — every
 * prompt they typed, including whatever credential they pasted into one — and unlike the vault
 * beside it, it is not encrypted. Its mode is therefore the whole of its protection, so it is
 * stated here rather than left to the umask.
 *
 * `O_NONBLOCK` is not an optimisation: opening a FIFO for writing blocks until a reader appears,
 * and a hook that never returns holds up the prompt that triggered it. With the flag the open
 * fails immediately instead, and the `isFile` check refuses the target either way.
 */
function appendToRegularFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      note(`refusing to write envelopes to ${path}: not a regular file`);
      return;
    }
    const bytes = Buffer.from(data, 'utf8');
    for (let written = 0; written < bytes.length; ) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
  } finally {
    closeSync(fd);
  }
}

try {
  const persona = process.env.SERVANDA_PERSONA;
  const log = process.env.SERVANDA_ENVELOPE_LOG;
  // Capture that silently does nothing is indistinguishable from having promised nothing, and
  // this is the likeliest way to ship it: one variable missing from the registration.
  if (!persona) note('SERVANDA_PERSONA is not set; capturing nothing');
  if (!log) note('SERVANDA_ENVELOPE_LOG is not set; capturing nothing');
  if (persona && log) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // The only clock read in the whole connector, taken once at the process boundary.
    const now = new Date().toISOString();
    const envelopes = new ClaudeCodeConnector({ persona }).fromHookEvent(event, {
      occurredAt: now,
      receivedAt: now,
    });
    if (envelopes.length > 0) {
      appendToRegularFile(log, envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  }
} catch (err) {
  note(err instanceof Error ? err.message : String(err));
}
process.exit(0);
