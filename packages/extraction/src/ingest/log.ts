import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { Envelope } from '@servanda/types';

/**
 * Reading back the NDJSON envelope log the §2 connectors append to.
 *
 * The log is a one-writer, many-restarts append log on a local disk, and every hard part of
 * reading one is a question about *what happened while nobody was looking*: the file was rotated,
 * it was truncated, it grew past what one read can hold, or the last line was still being written
 * when we got there. Each of those is answered below, and each is answered by refusing to guess.
 *
 * Two properties are load-bearing and neither is obvious from the type:
 *
 *  1. **The target must `fstat` as a regular file.** The writer already requires this, for the
 *     reason that `SERVANDA_ENVELOPE_LOG=/dev/stdout` put verbatim prompts back into the model's
 *     context. The reader requires it for a *different* reason, and both reasons are real. A FIFO
 *     has no stable byte offset, so a cursor over one is meaningless and nothing downstream can be
 *     idempotent; and a character device is a channel some other process is on the far end of, so
 *     "the log" would be whatever that process decides to say — arbitrary envelopes, under any
 *     persona, straight into extraction. The check is cheap and it is the only thing that makes
 *     the cursor mean anything.
 *  2. **Nothing here writes.** The fd is `O_RDONLY`; the cursor is three integers. An ingest path
 *     that touched the log would be an ingest path that could be made to.
 */

export class EnvelopeLogNotRegularFileError extends Error {
  constructor(readonly path: string) {
    super(`refusing to read envelopes from ${path}: not a regular file`);
    this.name = 'EnvelopeLogNotRegularFileError';
  }
}

/**
 * Where the last read stopped. Three integers and nothing else — see `cursorCarriesNoContent`
 * in the tests, which is the assertion that keeps it that way.
 *
 * `dev`/`ino` are the file's identity, not its name. A rotated log keeps the name and changes the
 * inode, which is exactly the case a byte offset alone cannot tell from "nothing new happened".
 */
export interface EnvelopeLogCursor {
  readonly dev: number;
  readonly ino: number;
  readonly offset: number;
}

export interface EnvelopeLogStats {
  readonly bytesConsumed: number;
  readonly linesRead: number;
  /** Not JSON, or JSON that is not a §2 envelope. Counted, never repaired, never quoted. */
  readonly linesMalformed: number;
  /** A well-formed envelope belonging to another persona (M-5). Counted, never extracted. */
  readonly linesForeignPersona: number;
  readonly envelopes: number;
  /** The inode changed under us: the log was rotated or replaced. Restarted from byte 0. */
  readonly rotated: boolean;
  /** The file is shorter than the cursor: it was truncated in place. Restarted from byte 0. */
  readonly truncated: boolean;
  /** More bytes remain past the budget. The caller should read again from the returned cursor. */
  readonly budgetExhausted: boolean;
  /** Bytes after the final newline, deliberately left for next time. */
  readonly partialTailBytes: number;
}

export interface EnvelopeLogRead {
  readonly envelopes: readonly Envelope[];
  readonly cursor: EnvelopeLogCursor;
  readonly stats: EnvelopeLogStats;
}

export interface ReadEnvelopeLogOptions {
  /** M-5: the one persona this read is for. */
  readonly persona: string;
  readonly cursor?: EnvelopeLogCursor;
  readonly maxBytes?: number;
}

/**
 * How much of the log one call will read.
 *
 * The log has no ceiling — it grows for as long as the person keeps working — and a first pass
 * that read it whole would hold the entire thing in memory to produce one batch. 8 MiB is
 * comfortably more than a §2 envelope's 64 KiB ceiling, so a single line always fits, and small
 * enough that a year-old log costs a loop rather than a heap.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A line that cannot fit in one budget would stall the cursor forever: every call would read the
 * same bytes, find no newline, and consume nothing. §2 bounds a whole envelope at 64 KiB, so a
 * line past this is not a slow writer — it is a file that is not this log. It is skipped as
 * malformed, which advances the cursor, rather than retried.
 */
const MAX_LINE_BYTES = 1024 * 1024;

interface Consumed {
  readonly text: string;
  readonly bytes: number;
  readonly partialTailBytes: number;
  readonly budgetExhausted: boolean;
}

/** Read from `start`, and hand back only the whole lines. The tail is somebody's unfinished write. */
function consume(fd: number, start: number, size: number, maxBytes: number): Consumed {
  const want = Math.min(maxBytes, Math.max(0, size - start));
  if (want === 0) {
    return { text: '', bytes: 0, partialTailBytes: 0, budgetExhausted: false };
  }
  const buffer = Buffer.allocUnsafe(want);
  let filled = 0;
  while (filled < want) {
    const n = readSync(fd, buffer, filled, want - filled, start + filled);
    if (n === 0) break; // the file shrank mid-read; what we have is what there is
    filled += n;
  }
  const budgetExhausted = size - start > want;
  const lastNewline = buffer.lastIndexOf(0x0a, filled - 1);
  if (lastNewline < 0) {
    // No line terminator anywhere in the budget. Either the writer is mid-line (fine, wait) or
    // the line is longer than any envelope may be (not fine, and waiting never ends).
    if (filled >= MAX_LINE_BYTES) {
      return { text: buffer.toString('utf8', 0, filled), bytes: filled, partialTailBytes: 0, budgetExhausted };
    }
    return { text: '', bytes: 0, partialTailBytes: filled, budgetExhausted };
  }
  return {
    text: buffer.toString('utf8', 0, lastNewline + 1),
    bytes: lastNewline + 1,
    partialTailBytes: filled - (lastNewline + 1),
    budgetExhausted,
  };
}

/**
 * Read whatever the log has gained since `cursor`.
 *
 * Throws only for a target that is not a regular file, and for the errors `open` raises — a
 * missing log is `ENOENT` and belongs to the caller, because "the hook has never run" and "the
 * hook is misconfigured" are the same absence and only the caller knows which it was expecting.
 */
export function readEnvelopeLog(path: string, options: ReadEnvelopeLogOptions): EnvelopeLogRead {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new EnvelopeLogNotRegularFileError(path);

    const cursor = options.cursor;
    const sameFile = cursor !== undefined && cursor.dev === stat.dev && cursor.ino === stat.ino;
    const rotated = cursor !== undefined && !sameFile;
    const truncated = sameFile && stat.size < cursor.offset;
    const start = sameFile && !truncated ? cursor.offset : 0;

    const chunk = consume(fd, start, stat.size, options.maxBytes ?? DEFAULT_MAX_BYTES);

    const envelopes: Envelope[] = [];
    let linesRead = 0;
    let linesMalformed = 0;
    let linesForeignPersona = 0;

    for (const line of chunk.text.split('\n')) {
      if (line.length === 0) continue;
      linesRead++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        linesMalformed++;
        continue;
      }
      const envelope = Envelope.safeParse(parsed);
      if (!envelope.success) {
        // The zod error is discarded rather than reported. It quotes the input, and the input is
        // whatever the person typed into their agent; a diagnostic that carries it turns every
        // log line of this ingest into a second, unprotected copy of the capture.
        linesMalformed++;
        continue;
      }
      if (envelope.data.persona !== options.persona) {
        // Not dropped silently — counted, and surfaced on the run. `Extractor` refuses a whole
        // mixed BATCH, and is right to: a batch is assembled by us, so a foreign envelope in one
        // is our bug. A log is different. Two personas' hooks may be registered against the same
        // path, which nothing in the writer prevents, and refusing the read would wedge the cursor
        // on the first foreign line and stop ingest for good.
        linesForeignPersona++;
        continue;
      }
      envelopes.push(envelope.data);
    }

    return {
      envelopes,
      cursor: { dev: stat.dev, ino: stat.ino, offset: start + chunk.bytes },
      stats: {
        bytesConsumed: chunk.bytes,
        linesRead,
        linesMalformed,
        linesForeignPersona,
        envelopes: envelopes.length,
        rotated,
        truncated,
        budgetExhausted: chunk.budgetExhausted,
        partialTailBytes: chunk.partialTailBytes,
      },
    };
  } finally {
    closeSync(fd);
  }
}
