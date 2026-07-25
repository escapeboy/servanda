#!/usr/bin/env node
// Claude Code session hook. Register it per-event in settings.json, e.g.
//
//   { "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
//       "command": "servanda-cc-hook" } ] } ] } }
//
// Environment (registration is where the persona binding happens — §2 / M-5):
//   SERVANDA_PERSONA      required, hex ed25519 persona id
//   SERVANDA_ENVELOPE_LOG required, path to append NDJSON envelopes to
//
// This process writes NOTHING to stdout. A hook's stdout is fed back into the session, so
// echoing envelopes there would push observed content into the model's context — the exact
// inversion M-6 forbids. Failures are silent on stdout and non-fatal to the session.
import { appendFileSync } from 'node:fs';
import { ClaudeCodeConnector } from '../dist/index.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const persona = process.env.SERVANDA_PERSONA;
  const log = process.env.SERVANDA_ENVELOPE_LOG;
  if (!persona || !log) process.exit(0);

  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // The only clock read in the whole connector, taken once at the process boundary.
  const now = new Date().toISOString();
  const envelopes = new ClaudeCodeConnector({ persona }).fromHookEvent(event, {
    occurredAt: now,
    receivedAt: now,
  });
  if (envelopes.length > 0) {
    appendFileSync(log, envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
} catch (err) {
  process.stderr.write(`servanda-cc-hook: ${err instanceof Error ? err.message : String(err)}\n`);
}
process.exit(0);
