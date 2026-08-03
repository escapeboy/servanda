import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeLogNotRegularFileError,
  ingestEnvelopeLog,
  MemoryPendingSink,
  readEnvelopeLog,
} from '../src/index.js';
import type { EnvelopeLogCursor, IngestResult } from '../src/index.js';
import { createRecordingModelClient, createScriptedModelClient, createStubModelClient } from '../src/stub.js';
import { envelope, PERSONA_A, PERSONA_B } from './fixtures.js';

/**
 * §3's capture surface, read back.
 *
 * The hook has always appended envelopes to `$SERVANDA_ENVELOPE_LOG`, and until now nothing in
 * the repository opened that file. Everything below is about the half that was missing, and most
 * of it is about the same question asked four ways: *what happens to the file while nobody is
 * looking at it* — rotated, truncated, half-written, grown past one read — and does any of those
 * turn one promise into two, or into none.
 */

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'connectors-claude-code',
  'bin',
  'servanda-cc-hook.mjs',
);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'servanda-ingest-'));
}

function writeLog(lines: readonly string[]): string {
  const path = join(scratch(), 'envelopes.ndjson');
  writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 });
  return path;
}

const PROMISES = [
  'I will send Maria the quote by Friday, whatever else happens this week.',
  'I am going to rewrite the retry logic before the release goes out.',
  'I promise to review the migration guide for Ivan tomorrow morning.',
];

const occurredAt = (i: number): string =>
  new Date(Date.parse('2026-07-01T10:00:00Z') + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function logOf(texts: readonly string[], persona = PERSONA_A): string {
  return writeLog(texts.map((text, i) => JSON.stringify(envelope(text, persona, occurredAt(i)))));
}

async function ingest(
  logPath: string,
  sink: MemoryPendingSink,
  overrides: Partial<Parameters<typeof ingestEnvelopeLog>[0]> = {},
): Promise<IngestResult> {
  return ingestEnvelopeLog({
    logPath,
    persona: PERSONA_A,
    model: createStubModelClient(),
    sink,
    now: () => '2026-07-25T12:00:00Z',
    ...overrides,
  });
}

describe('the envelope log reaches the confirmation queue', () => {
  /**
   * The headline. A person registers the shipped hook, types promises at their agent, and the
   * promises show up somewhere a human can act on them. This drives the REAL hook process, not a
   * fixture, because the value of the whole path is that the file the hook writes is the file
   * ingest reads — two independent modules agreeing on a format neither one owns.
   */
  it('carries what the shipped hook wrote into a sink', async () => {
    const log = join(scratch(), 'envelopes.ndjson');
    for (const prompt of PROMISES) {
      const run = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt,
          session_id: 'sess-1',
          cwd: '/Users/dana/htdocs/api',
        }),
        env: { ...process.env, SERVANDA_PERSONA: PERSONA_A, SERVANDA_ENVELOPE_LOG: log },
        timeout: 20_000,
      });
      expect(run.status, (run.stderr ?? Buffer.alloc(0)).toString()).toBe(0);
    }

    const sink = new MemoryPendingSink();
    const result = await ingest(log, sink);

    expect(result.logMissing).toBe(false);
    expect(result.log?.envelopes).toBeGreaterThanOrEqual(PROMISES.length);
    expect(result.envelopesIngested).toBeGreaterThanOrEqual(PROMISES.length);
    expect(result.queued).toBeGreaterThan(0);
    expect(sink.queued.length).toBe(result.queued);
    // What a person would see: a candidate quoting them, awaiting their act and nothing else.
    expect(sink.queued.some((q) => q.candidate.quote.includes('Maria'))).toBe(true);
  });

  it('routes a resolvable counterparty to the one disposition that can ever be proposed', async () => {
    const sink = new MemoryPendingSink();
    await ingest(logOf(PROMISES), sink, {
      resolveParty: (label) => (label === 'Ivan' ? PERSONA_B : null),
    });
    const dispositions = new Set(sink.queued.map((q) => q.candidate.disposition));
    expect(dispositions.has('proposable-after-confirmation')).toBe(true);
    for (const q of sink.queued) {
      // Nothing here is a commitment yet, and nothing here has been signed. The sink is the end
      // of this path; `confirm` is a different act by a different actor.
      expect(q.candidate.commitment?.source ?? 'extracted').toBe('extracted');
    }
  });

  it('reports a log that does not exist rather than throwing', async () => {
    const result = await ingest(join(scratch(), 'never-written.ndjson'), new MemoryPendingSink());
    expect(result.logMissing).toBe(true);
    expect(result.queued).toBe(0);
  });
});

describe('reading the same log twice does not create the same promise twice', () => {
  it('is idempotent when the cursor survives', async () => {
    const log = logOf(PROMISES);
    const sink = new MemoryPendingSink();
    const first = await ingest(log, sink);
    const second = await ingest(log, sink, { cursor: first.cursor });

    expect(first.queued).toBeGreaterThan(0);
    expect(second.log?.bytesConsumed).toBe(0);
    expect(second.queued).toBe(0);
    expect(sink.queued.length).toBe(first.queued);
  });

  /**
   * The case the cursor cannot save. A cursor is a file on disk like any other: it is lost in a
   * restore, cleared by a reinstall, or simply never written because the process died first. Then
   * ingest reads the log from byte zero — and if that queued every promise again, the person's
   * confirmation queue would double every time their laptop crashed.
   */
  it('is idempotent when the cursor is lost entirely', async () => {
    const log = logOf(PROMISES);
    const sink = new MemoryPendingSink();
    const first = await ingest(log, sink);
    const second = await ingest(log, sink); // no cursor at all: re-reads from the top

    expect(second.log?.bytesConsumed).toBeGreaterThan(0);
    expect(second.alreadyIngested).toBe(first.envelopesIngested);
    expect(second.queued).toBe(0);
    expect(sink.queued.length).toBe(first.queued);
  });

  /** And it must not re-ask the model either, or the crash is free of duplicates but not of money. */
  it('does not pay for an envelope it has already seen', async () => {
    const log = logOf(PROMISES);
    const sink = new MemoryPendingSink();
    await ingest(log, sink);
    const recording = createRecordingModelClient();
    await ingest(log, sink, { model: recording });
    expect(recording.bodies.length).toBe(0);
  });

  /**
   * An envelope the model found nothing in is still an envelope that has been looked at. Left
   * unmarked, it is re-sent on every run for the life of the log — and most utterances contain no
   * promise, so that is nearly all of them.
   */
  it('marks an envelope that yielded nothing, so it is never re-sent', async () => {
    const log = logOf(['Could you check whether the cache is warm? Just wondering about it.']);
    const sink = new MemoryPendingSink();
    const first = await ingest(log, sink);
    expect(first.queued).toBe(0);
    expect(first.envelopesIngested).toBe(1);

    const recording = createRecordingModelClient();
    const second = await ingest(log, sink, { model: recording });
    expect(second.alreadyIngested).toBe(1);
    expect(recording.bodies.length).toBe(0);
  });
});

describe('the log changes shape underneath the reader', () => {
  it('notices rotation and does not re-queue what survived it', async () => {
    const dir = scratch();
    const log = join(dir, 'envelopes.ndjson');
    const lines = PROMISES.map((t, i) =>
      JSON.stringify(envelope(t, PERSONA_A, `2026-07-0${i + 1}T10:00:00Z`)),
    );
    writeFileSync(log, `${lines.join('\n')}\n`, { mode: 0o600 });

    const sink = new MemoryPendingSink();
    const first = await ingest(log, sink);
    const queuedBefore = sink.queued.length;

    // What logrotate does: move the file aside, start a fresh one at the same path. The old
    // offset now points into the middle of a different file's bytes. The new file deliberately
    // repeats the last old line — a rotation that keeps a tail is the version that duplicates.
    renameSync(log, join(dir, 'envelopes.ndjson.1'));
    const fresh = JSON.stringify(
      envelope('I will file the incident report on Monday.', PERSONA_A, '2026-08-01T10:00:00Z'),
    );
    writeFileSync(log, `${lines[lines.length - 1]}\n${fresh}\n`, { mode: 0o600 });

    const repeatedId = (JSON.parse(lines[lines.length - 1]!) as { id: string }).id;
    const forRepeated = (): number =>
      sink.queued.filter((q) => q.envelopeId === repeatedId).length;
    const repeatedBefore = forRepeated();

    const second = await ingest(log, sink, { cursor: first.cursor });
    expect(second.log?.rotated).toBe(true);
    // The repeated line is recognised as already seen; only the genuinely new one is queued.
    expect(second.alreadyIngested).toBe(1);
    expect(second.envelopesIngested).toBe(1);
    expect(sink.queued.length).toBeGreaterThan(queuedBefore);
    expect(forRepeated()).toBe(repeatedBefore);
  });

  it('notices truncation in place and re-reads without duplicating', async () => {
    const log = logOf(PROMISES);
    const sink = new MemoryPendingSink();
    const first = await ingest(log, sink);
    const queuedBefore = sink.queued.length;

    // `: > file` — same inode, zero length. The cursor is now past the end of its own file.
    truncateSync(log, 0);
    appendFileSync(
      log,
      `${JSON.stringify(envelope('I will file the incident report on Monday.', PERSONA_A, '2026-08-01T10:00:00Z'))}\n`,
    );

    const second = await ingest(log, sink, { cursor: first.cursor });
    expect(second.log?.truncated).toBe(true);
    expect(second.queued).toBeGreaterThan(0);
    expect(sink.queued.length).toBeGreaterThan(queuedBefore);
    expect(second.alreadyIngested).toBe(0);
  });

  /**
   * The hook appends with one `write` per event, but a reader arriving mid-syscall sees a
   * fragment. Parsing it would count a malformed line and — worse — advance the cursor past the
   * bytes, so the completed line would never be read at all. A promise lost to a race.
   */
  it('holds back a half-written final line until it is whole', async () => {
    const dir = scratch();
    const log = join(dir, 'envelopes.ndjson');
    const whole = JSON.stringify(envelope(PROMISES[0]!, PERSONA_A));
    const next = JSON.stringify(envelope(PROMISES[1]!, PERSONA_A));
    writeFileSync(log, `${whole}\n${next.slice(0, 40)}`, { mode: 0o600 });

    const sink = new MemoryPendingSink();
    const first = await ingest(log, sink);
    expect(first.log?.partialTailBytes).toBeGreaterThan(0);
    expect(first.log?.linesMalformed).toBe(0);
    expect(first.log?.envelopes).toBe(1);

    appendFileSync(log, `${next.slice(40)}\n`);
    const second = await ingest(log, sink, { cursor: first.cursor });
    expect(second.log?.linesMalformed).toBe(0);
    expect(second.log?.envelopes).toBe(1);
  });

  it('reads a log larger than one budget in bounded steps, each envelope exactly once', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `I will finish task ${i} by Friday.`);
    const log = logOf(many);
    const size = statSync(log).size;
    const sink = new MemoryPendingSink();

    let cursor: EnvelopeLogCursor | undefined;
    let steps = 0;
    let ingested = 0;
    for (;;) {
      const result: IngestResult = await ingest(log, sink, {
        maxBytes: Math.max(1024, Math.floor(size / 5)),
        ...(cursor === undefined ? {} : { cursor }),
      });
      ingested += result.envelopesIngested;
      cursor = result.cursor;
      steps++;
      if (result.log?.budgetExhausted !== true) break;
      expect(steps).toBeLessThan(50); // a budget that never advances is the failure mode
    }

    expect(steps).toBeGreaterThan(1);
    expect(ingested).toBe(many.length);
    expect(sink.ingestedCount).toBe(many.length);
  });
});

describe('what the reader refuses', () => {
  /**
   * The writer refuses a non-regular target because `/dev/stdout` put verbatim prompts back into
   * the model's context. The reader refuses it for a different reason, and the reason is why this
   * is not a copied check: a FIFO has no stable offset, so no cursor over one means anything and
   * nothing downstream can be idempotent — and whatever process is on the far end gets to decide
   * what "the log" says, under any persona it likes.
   */
  it('refuses a target that is not a regular file', () => {
    const dir = scratch();
    expect(() => readEnvelopeLog(dir, { persona: PERSONA_A })).toThrow(
      EnvelopeLogNotRegularFileError,
    );

    const fifo = join(dir, 'pipe');
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      expect(() => readEnvelopeLog(fifo, { persona: PERSONA_A })).toThrow(
        EnvelopeLogNotRegularFileError,
      );
    }
  });

  it('skips a malformed line instead of throwing on it', async () => {
    const log = writeLog([
      'not json at all',
      '{"type":"envelope"}',
      JSON.stringify(envelope(PROMISES[0]!, PERSONA_A)),
      '{"truncated": ',
    ]);
    const result = await ingest(log, new MemoryPendingSink());
    expect(result.log?.linesMalformed).toBe(3);
    expect(result.log?.envelopes).toBe(1);
  });

  /**
   * M-5. Two personas' hooks pointed at one path is not a hypothetical: §3's registration snippet
   * names a literal `$HOME/.servanda-envelopes.ndjson`, and nothing in the writer keeps a second
   * persona out of it. `Extractor` refuses a whole mixed *batch* and is right to — a batch is
   * assembled here, so a foreign envelope in one is our bug. A log is appended to by someone else,
   * and refusing the read would wedge the cursor on the first foreign line forever.
   */
  it('counts another persona\'s envelopes and never sends them to a model', async () => {
    const canary = 'CANARY-b7f2-other-persona-secret';
    const log = writeLog([
      JSON.stringify(envelope(PROMISES[0]!, PERSONA_A)),
      JSON.stringify(envelope(`I will leak ${canary} by Friday.`, PERSONA_B)),
    ]);
    const recording = createRecordingModelClient();
    const result = await ingest(log, new MemoryPendingSink(), { model: recording });

    expect(result.log?.linesForeignPersona).toBe(1);
    expect(result.log?.envelopes).toBe(1);
    expect(JSON.stringify(recording.bodies)).not.toContain(canary);
  });
});

describe('nothing captured leaks out sideways', () => {
  /**
   * The cursor is persisted by the node, wherever the node keeps state — and the vault is a git
   * repository that commits everything in it. Three integers can go there. A quoted log line
   * could not: it would put the person's prompt, in cleartext, into a history that keeps it
   * forever. Same for the run's statistics, which are the natural thing to print.
   */
  it('keeps captured text out of the cursor and out of the statistics', async () => {
    const canary = 'CANARY-3d91-the-passphrase-is-hunter2';
    const log = writeLog([
      JSON.stringify(envelope(`I will rotate the key; ${canary}.`, PERSONA_A)),
      `{"type":"envelope","payload":{"text":"${canary}"} malformed`,
      JSON.stringify(envelope(canary, PERSONA_B)),
    ]);
    const result = await ingest(log, new MemoryPendingSink());

    expect(JSON.stringify(result.cursor)).not.toContain(canary);
    expect(JSON.stringify(result.log)).not.toContain(canary);
    expect(JSON.stringify(result.rejectedBatches)).not.toContain(canary);
  });
});

describe('a batch the model spoils is deferred, never discarded', () => {
  /**
   * §3.4 discards a whole response that does not validate. If ingest then advanced its cursor,
   * those envelopes would be gone: never read again, never extracted, and nothing would say so.
   * The cursor therefore stops where INGEST stopped, not where the READ stopped — the run reports
   * a number that does not move rather than losing promises quietly.
   */
  it('leaves the cursor where it started and re-reads the batch next run', async () => {
    const log = logOf(PROMISES);
    const sink = new MemoryPendingSink();
    const spoiled = await ingest(log, sink, {
      model: createScriptedModelClient('{"results":[{"nonsense":true}]}'),
    });

    expect(spoiled.rejectedBatches.length).toBeGreaterThan(0);
    expect(spoiled.cursorAdvanced).toBe(false);
    expect(spoiled.cursor?.offset).toBe(0);
    expect(spoiled.envelopesDeferred).toBeGreaterThan(0);
    expect(sink.queued.length).toBe(0);
    expect(sink.ingestedCount).toBe(0);

    const recovered = await ingest(log, sink, { cursor: spoiled.cursor });
    expect(recovered.queued).toBeGreaterThan(0);
    expect(recovered.cursorAdvanced).toBe(true);
  });
});
