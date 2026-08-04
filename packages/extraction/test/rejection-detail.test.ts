import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelClient } from '../src/model.js';
import { ingestEnvelopeLog } from '../src/ingest/run.js';
import { MemoryPendingSink } from '../src/ingest/sink.js';
import { PERSONA_A, envelope } from './fixtures.js';

/**
 * Whether a model's failure can carry the person's own words out with it.
 *
 * `run.ts` catches anything thrown by `extractor.extract` and puts
 * `String(e.message).slice(0, 200)` into `rejection.detail`. That is the ONE place in the ingest
 * path whose contents come from a third party rather than from this repository, and T5 recorded
 * it honestly as the one thing it could not claim was canary-clean: the Anthropic SDK puts a
 * RESPONSE body in `message`, not a request — which is a fact about somebody else's library, not
 * an invariant anybody here maintains.
 *
 * A fact about another library is testable, and that is what this does rather than deciding
 * anything. If a thrown error's message contains the captured text, `detail` carries it; if the
 * path strips it, the concern is closed. Either answer is worth more than the caveat.
 */
const CANARY = 'PINEAPPLE-QUARTZ-7731 the exact words a person typed at their agent';

function logWith(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'servanda-detail-')), 'envelopes.ndjson');
  writeFileSync(path, `${JSON.stringify(envelope(text, PERSONA_A, '2026-07-01T10:00:00Z'))}\n`, {
    mode: 0o600,
  });
  return path;
}

/** A client that fails the way a real SDK does: with the payload quoted back inside the error. */
function echoingFailure(): ModelClient {
  return {
    id: 'stub:echoing-failure',
    complete: (request) => {
      // The canary goes at the FRONT, and that is the whole design of this stand-in.
      //
      // The first version put it behind a JSON blob and the test passed — because the old
      // `slice(0, 200)` cut before it, not because anything protected it. A probe with the same
      // message and the canary at the front leaked. A stand-in that only exercises the lucky
      // position tests the truncation, not the rule.
      throw Object.assign(
        new Error(`${CANARY} — and then whatever the vendor wanted to say: ${JSON.stringify(request).slice(0, 400)}`),
        { status: 400 },
      );
    },
  };
}

describe('a model failure and the words that reached it', () => {
  it('records the batch as rejected rather than swallowing it', async () => {
    const sink = new MemoryPendingSink();
    const result = await ingestEnvelopeLog({
      logPath: logWith(CANARY),
      persona: PERSONA_A,
      model: echoingFailure(),
      sink,
      now: () => '2026-07-25T12:00:00Z',
    });
    expect(result.rejectedBatches.length).toBeGreaterThan(0);
    expect(result.rejectedBatches[0]!.rejection.stage).toBe('transport');
    // Nothing was queued and the cursor did not move: a rejected batch is deferred, not lost.
    expect(result.queued).toBe(0);
    expect(result.cursorAdvanced).toBe(false);
  });

  it('and `rejection.detail` does NOT carry the person’s words back out', async () => {
    const sink = new MemoryPendingSink();
    const result = await ingestEnvelopeLog({
      logPath: logWith(CANARY),
      persona: PERSONA_A,
      model: echoingFailure(),
      sink,
      now: () => '2026-07-25T12:00:00Z',
    });
    const detail = result.rejectedBatches[0]!.rejection.detail;
    // The whole point. `detail` is a diagnostic string, and ingest is meant to run unattended and
    // be logged — so anything it carries is a second, unprotected copy of what §3 captured, in a
    // file with none of the vault's guarantees on it.
    expect(detail).not.toContain(CANARY);
    expect(detail).not.toContain('PINEAPPLE');
    // And what DOES survive is what somebody acts on: which class of failure, and the status.
    // Rate-limited, bad-request and network-down are three different responses.
    expect(detail).toContain('Error');
    expect(detail).toContain('400');
  });
});
