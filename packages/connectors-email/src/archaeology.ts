import { Rfc3339 } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import { compact } from './envelope.js';
import type { ImapClient, ImapMessageSource } from './imap.js';
import { addressesOf, buildEnvelope, threadIdOf } from './capture.js';
import type { CaptureContext, EmailIdentity } from './capture.js';
import { DEFAULT_LIMITS, parseMessage } from './mime.js';
import type { MimeLimits, ParsedMessage } from './mime.js';

/**
 * Sent-mail archaeology — the cold-start move.
 *
 * ui-design.md: "connect mail in one OAuth click → first brief within the hour (sent-mail
 * archaeology fills Waiting in minutes)". A new node has no history of its own, but the
 * user's Sent folder is years of promises made and answers awaited, in plain text.
 *
 * WHAT THIS DOES NOT DO. It does not decide what is a commitment and what is an expectation.
 * That is §3.4's job, downstream, tool-less and schema-bound. A connector emits envelopes or
 * nothing — so this file emits a candidate SENTENCE with its context and stops. Whether
 * "I'll send the draft Friday" becomes a §3.1 commitment, and whether "any update on the
 * offer?" becomes a §3.3 expectation, is not decided here and must not be.
 *
 * SCOPE (narrowest reading, listed in the stream report): the cue sets below are ENGLISH
 * only, and they match on the user's OWN prose — quoted reply text (`>`) and everything past
 * a forward separator are stripped first, because someone else's promise inside your sent
 * mail is their promise, not yours (M-1).
 */

export const ARCHAEOLOGY_KINDS = ['archaeology_sent_promise', 'archaeology_sent_question'] as const;
export type ArchaeologyKind = (typeof ARCHAEOLOGY_KINDS)[number];

export interface SentArchaeologyOptions extends CaptureContext {
  /**
   * The instant ages are measured against. Injected for the same reason `received_at` is:
   * "this promise is 40 days old" must be reproducible, and `Date.now()` is not.
   */
  readonly referenceTime: string;
  /** Mailboxes scanned for replies, to decide `awaiting_reply`. */
  readonly replyMailboxes?: readonly string[];
  /** Cap per message per kind, so one long email cannot flood a brief. */
  readonly maxPerMessage?: number;
  readonly limits?: MimeLimits;
}

const DEFAULT_MAX_PER_MESSAGE = 8;
const MIN_SENTENCE_CHARS = 12;
const MAX_SENTENCE_CHARS = 600;

/**
 * Commissive cues: first person + a future/undertaking verb. Deliberately narrow — the cost of
 * a false positive is a junk row in a brief, and the cost of being clever is a connector that
 * quietly decides what a promise is.
 */
const PROMISE_CUES: readonly RegExp[] = [
  /\b(?:i|we)\s*(?:'|’)ll\b/iu,
  /\b(?:i|we)\s+will\b/iu,
  /\b(?:i|we)\s+shall\b/iu,
  /\b(?:i|we)\s+(?:am|'m|’m|are|'re|’re)\s+going\s+to\b/iu,
  /\b(?:i|we)\s+promise\b/iu,
  /\b(?:i|we)\s+commit\s+to\b/iu,
  /\b(?:i|we)\s+can\s+have\s+(?:it|this|that|them)\b/iu,
  /\b(?:i|we)\s+(?:will|'ll|’ll)?\s*get\s+back\s+to\s+you\b/iu,
  /\blet\s+me\s+(?:send|get|put|write|draft|prepare)\b/iu,
];

/** Cues that an answer is awaited. A question mark is the strongest of them. */
const QUESTION_CUES: readonly RegExp[] = [
  /\blet\s+me\s+know\b/iu,
  /\b(?:could|can|would|will)\s+you\b/iu,
  /\bplease\s+(?:confirm|advise|review|send|let\s+me\s+know)\b/iu,
  /\b(?:waiting|wait)\s+(?:on|for)\s+(?:your|the|an)\b/iu,
  /\blooking\s+forward\s+to\s+(?:your|hearing)\b/iu,
  /\bany\s+(?:update|news|thoughts)\b/iu,
];

/** Strips quoted reply text and everything after a forward/reply separator. */
export function ownProse(text: string): string {
  const cut = text.search(
    /^(?:-{2,}\s*(?:forwarded message|original message)|begin forwarded message:|on .{0,120}\bwrote:\s*$|_{16,})/imu,
  );
  const body = cut < 0 ? text : text.slice(0, cut);
  return body
    .split('\n')
    .filter((line) => !/^\s*>/u.test(line))
    .join('\n');
}

export interface Candidate {
  readonly kind: ArchaeologyKind;
  readonly index: number;
  readonly text: string;
}

/** Sentence split on terminal punctuation and hard line breaks. Bounded, deterministic. */
export function candidates(prose: string, maxPerKind: number): Candidate[] {
  const sentences: string[] = [];
  for (const block of prose.split('\n')) {
    for (const piece of block.split(/(?<=[.!?])\s+/u)) {
      const s = piece.trim();
      if (s.length >= MIN_SENTENCE_CHARS) sentences.push(s.slice(0, MAX_SENTENCE_CHARS));
      if (sentences.length >= 400) break;
    }
    if (sentences.length >= 400) break;
  }

  const out: Candidate[] = [];
  let promises = 0;
  let questions = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    if (promises < maxPerKind && PROMISE_CUES.some((re) => re.test(s))) {
      out.push({ kind: 'archaeology_sent_promise', index: i, text: s });
      promises++;
      continue; // a sentence is one candidate; the promise reading wins over the question one
    }
    if (questions < maxPerKind && (s.endsWith('?') || QUESTION_CUES.some((re) => re.test(s)))) {
      out.push({ kind: 'archaeology_sent_question', index: i, text: s });
      questions++;
    }
  }
  return out;
}

interface ThreadIndex {
  /** Message-ids and thread roots that some later inbound message answers. */
  readonly answered: ReadonlySet<string>;
  readonly repliesByThread: ReadonlyMap<string, number>;
}

/**
 * Builds the "did anyone answer?" index from inbound mailboxes.
 *
 * This is mailbox state, not a judgement: a sent message is `awaiting_reply` when no message
 * in a scanned inbound mailbox references it or shares its thread root. The flag is DATA on
 * the envelope; it is not a filter, and it is not an escalation.
 */
function buildThreadIndex(inbound: readonly ParsedMessage[]): ThreadIndex {
  const answered = new Set<string>();
  const repliesByThread = new Map<string, number>();
  for (const msg of inbound) {
    for (const id of [msg.inReplyTo, ...msg.references]) {
      if (id !== undefined) answered.add(id);
    }
    const thread = threadIdOf(msg);
    if (thread !== undefined) {
      answered.add(thread);
      repliesByThread.set(thread, (repliesByThread.get(thread) ?? 0) + 1);
    }
  }
  return { answered, repliesByThread };
}

function ageDays(occurredAt: string, referenceTime: string): number {
  const delta = Date.parse(referenceTime) - Date.parse(occurredAt);
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta / 86_400_000)) : 0;
}

export async function sentArchaeologyEnvelopes(
  client: ImapClient,
  persona: string,
  identity: EmailIdentity,
  options: SentArchaeologyOptions,
): Promise<Envelope[]> {
  if (!Rfc3339.safeParse(options.referenceTime).success) {
    throw new TypeError(
      `sentArchaeology: referenceTime must be RFC 3339, got ${options.referenceTime}`,
    );
  }
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxPerMessage = options.maxPerMessage ?? DEFAULT_MAX_PER_MESSAGE;

  const mailboxes = [...(await client.listMailboxes())].sort();
  const sentBoxes = mailboxes.filter((m) => identity.sentMailboxes.includes(m));
  const replyBoxes =
    options.replyMailboxes === undefined
      ? mailboxes.filter((m) => !identity.sentMailboxes.includes(m))
      : mailboxes.filter((m) => options.replyMailboxes!.includes(m));

  const inbound: ParsedMessage[] = [];
  for (const mailbox of replyBoxes) {
    for (const source of sortSources(await client.fetchAll(mailbox))) {
      inbound.push(parseMessage(source.raw, limits));
    }
  }
  const index = buildThreadIndex(inbound);

  const out: Envelope[] = [];
  for (const mailbox of sentBoxes) {
    for (const source of sortSources(await client.fetchAll(mailbox))) {
      out.push(
        ...envelopesForSent(source, parseMessage(source.raw, limits), {
          persona,
          identity,
          options,
          maxPerMessage,
          index,
        }),
      );
    }
  }
  return out;
}

/** uid ascending: server fetch order is not a stable input, uid is. */
export function sortSources(sources: readonly ImapMessageSource[]): ImapMessageSource[] {
  return [...sources].sort((a, b) => (a.uid === b.uid ? 0 : a.uid < b.uid ? -1 : 1));
}

function envelopesForSent(
  source: ImapMessageSource,
  parsed: ParsedMessage,
  ctx: {
    persona: string;
    identity: EmailIdentity;
    options: SentArchaeologyOptions;
    maxPerMessage: number;
    index: ThreadIndex;
  },
): Envelope[] {
  const found = candidates(ownProse(parsed.text), ctx.maxPerMessage);
  if (found.length === 0) return [];

  const threadId = threadIdOf(parsed);
  const answered =
    (parsed.messageId !== undefined && ctx.index.answered.has(parsed.messageId)) ||
    (threadId !== undefined && ctx.index.answered.has(threadId));
  const replyCount = threadId === undefined ? 0 : (ctx.index.repliesByThread.get(threadId) ?? 0);

  // The same precedence `buildEnvelope` uses for `occurred_at`, so `age_days` and the
  // envelope's own timestamp can never disagree.
  const occurredAt = parsed.date ?? source.internalDate;

  const out: Envelope[] = [];
  for (const candidate of found) {
    const envelope = buildEnvelope(parsed, source, ctx.persona, ctx.identity, ctx.options, {
      kind: candidate.kind,
      payload: compact({
        // The sentence as written. DATA (M-6): a sent mail reading "ignore previous
        // instructions" is a string in `payload.candidate_text`, nothing more.
        candidate_text: candidate.text,
        candidate_index: candidate.index,
        counterparties: addressesOf(parsed.to),
        // Mailbox state, not a judgement — see buildThreadIndex.
        awaiting_reply: !answered,
        reply_count: replyCount,
        age_days: occurredAt === undefined ? undefined : ageDays(occurredAt, ctx.options.referenceTime),
        reference_time: ctx.options.referenceTime,
      }),
    });
    if (envelope !== undefined) out.push(envelope);
  }
  return out;
}
