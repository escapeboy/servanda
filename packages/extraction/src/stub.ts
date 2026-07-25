import type { MessagesCreateFn, ModelClient, ModelRequest, ModelResponse } from './model.js';
import { toMessagesCreateBody } from './model.js';
import { OBSERVED_SIGNALS_CLOSE, OBSERVED_SIGNALS_OPEN } from './prompt.js';

/**
 * Deterministic stand-ins for the model.
 *
 * The stub exists so the whole pipeline — prompt, schema, routing, queue, report — can be run and
 * gated without an API key and without spend. It is a rule table, not a model: same input, same
 * output, every time. Its recall is poor by construction and that is fine; what it exercises is
 * the *containment*, which is the part that must hold whatever the model says.
 */

interface RenderedSignal {
  envelope_id: string;
  occurred_at: string;
  actor_label: string;
  text: string;
}

/** Read back exactly what the model would see. If the prompt stops carrying it, the stub notices. */
export function readSignals(request: ModelRequest): RenderedSignal[] {
  const content = request.messages.map((m) => m.content).join('\n');
  const start = content.indexOf(OBSERVED_SIGNALS_OPEN);
  const end = content.indexOf(OBSERVED_SIGNALS_CLOSE);
  if (start < 0 || end < 0) return [];
  const block = content.slice(start + OBSERVED_SIGNALS_OPEN.length, end).trim();
  try {
    const parsed: unknown = JSON.parse(block);
    return Array.isArray(parsed) ? (parsed as RenderedSignal[]) : [];
  } catch {
    return [];
  }
}

const FIRST_PERSON =
  /\bI['’]ll\b|\bI will\b|\bI am going to\b|\bI['’]m going to\b|\bI promise to\b/gi;
const THIRD_PERSON =
  /\b([A-Z][a-zA-Z]{1,20})\s+(?:said|says|promised|told me)\s+(?:he|she|they)\s*(?:'d|’d|would|will)\s+([^.!?\n]{3,160})/g;
const OWED_TO = /\b(?:for|to)\s+([A-Z][a-zA-Z]{1,20})\b/;
const DUE =
  /\bby\s+(\d{4}-\d{2}-\d{2}|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of (?:the )?week|next week)\b/i;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

function endOfDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T23:59:59Z`;
}

/** Resolve the handful of deadline phrasings the stub understands, relative to `occurredAt`. */
export function resolveDue(phrase: string, occurredAt: string): string | null {
  const base = new Date(occurredAt);
  if (Number.isNaN(base.getTime())) return null;
  const lower = phrase.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return `${lower}T23:59:59Z`;
  if (lower === 'today') return endOfDay(base);
  if (lower === 'tomorrow') return endOfDay(new Date(base.getTime() + 86_400_000));
  if (lower === 'next week') return endOfDay(new Date(base.getTime() + 7 * 86_400_000));
  if (lower.startsWith('end of')) {
    const delta = (5 - base.getUTCDay() + 7) % 7; // next Friday, inclusive of today
    return endOfDay(new Date(base.getTime() + delta * 86_400_000));
  }
  const index = WEEKDAYS.indexOf(lower as (typeof WEEKDAYS)[number]);
  if (index < 0) return null;
  const delta = (index - base.getUTCDay() + 7) % 7 || 7; // strictly the *next* such weekday
  return endOfDay(new Date(base.getTime() + delta * 86_400_000));
}

/**
 * A sentence ends at `.`/`!`/`?` followed by whitespace, or at a newline. Requiring the trailing
 * space matters: transcripts are full of `docs/02.md`, `v1.2`, and `foo.bar()`, and splitting on
 * a bare `.` chops quotes mid-clause.
 */
const SENTENCE_END = /[.!?](?=\s|$)|\n/g;
const MAX_QUOTE_CHARS = 400;

function sentenceAround(text: string, index: number): string {
  SENTENCE_END.lastIndex = 0;
  let from = 0;
  let to = text.length;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(text)) !== null) {
    if (match.index < index) {
      from = match.index + match[0].length;
    } else {
      to = match.index + match[0].length;
      break;
    }
  }
  return text.slice(from, Math.min(to, from + MAX_QUOTE_CHARS)).trim();
}

interface StubResult {
  envelope_id: string;
  intent: string;
  owner: 'local_user' | 'other_party';
  owner_label: string | null;
  owed_to: 'local_user' | 'other_party' | 'none';
  owed_to_label: string | null;
  due: string | null;
  confidence: number;
  quote: string;
}

const MAX_PER_SIGNAL = 3;

function extractFromSignal(signal: RenderedSignal): StubResult[] {
  const text = typeof signal.text === 'string' ? signal.text : '';
  const results: StubResult[] = [];

  FIRST_PERSON.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIRST_PERSON.exec(text)) !== null && results.length < MAX_PER_SIGNAL) {
    const quote = sentenceAround(text, match.index);
    if (quote.length < 12) continue;
    const dueMatch = DUE.exec(quote);
    const owedMatch = OWED_TO.exec(quote);
    const due = dueMatch?.[1] ? resolveDue(dueMatch[1], signal.occurred_at) : null;
    let confidence = 0.6;
    if (due !== null) confidence += 0.15;
    if (/\bI will\b|\bI promise to\b/i.test(quote)) confidence += 0.1;
    results.push({
      envelope_id: signal.envelope_id,
      intent: quote.slice(0, 500),
      owner: 'local_user',
      owner_label: null,
      owed_to: owedMatch?.[1] ? 'other_party' : 'none',
      owed_to_label: owedMatch?.[1] ?? null,
      due,
      confidence: Math.min(confidence, 0.9),
      quote: quote.slice(0, 2000),
    });
  }

  THIRD_PERSON.lastIndex = 0;
  while ((match = THIRD_PERSON.exec(text)) !== null && results.length < MAX_PER_SIGNAL * 2) {
    const who = match[1];
    const what = match[2];
    if (who === undefined || what === undefined) continue;
    const quote = sentenceAround(text, match.index);
    const dueMatch = DUE.exec(quote);
    results.push({
      envelope_id: signal.envelope_id,
      intent: `${who} undertook to ${what.trim()}`.slice(0, 500),
      owner: 'other_party',
      owner_label: who,
      owed_to: 'local_user',
      owed_to_label: null,
      due: dueMatch?.[1] ? resolveDue(dueMatch[1], signal.occurred_at) : null,
      confidence: 0.55,
      quote: quote.slice(0, 2000),
    });
  }

  return results;
}

/** A rule-driven stand-in for the extraction model. No network, no key, no spend. */
export function createStubModelClient(): ModelClient {
  return {
    id: 'stub:rules-v1',
    complete(request: ModelRequest): Promise<ModelResponse> {
      const results = readSignals(request).flatMap(extractFromSignal);
      return Promise.resolve({ text: JSON.stringify({ results }) });
    },
  };
}

/** Returns a fixed response, whatever the request. For testing what the boundary does with it. */
export function createScriptedModelClient(text: string, id = 'stub:scripted'): ModelClient {
  return { id, complete: () => Promise.resolve({ text }) };
}

export interface RecordingModelClient extends ModelClient {
  /** Every body that would have gone to the Anthropic API, verbatim. */
  readonly bodies: readonly Record<string, unknown>[];
  readonly create: MessagesCreateFn;
}

/**
 * Captures the exact API request body. Used by the M-06 test to assert on what crosses the
 * boundary rather than on what this package intended to send.
 */
export function createRecordingModelClient(responseText = '{"results":[]}'): RecordingModelClient {
  const bodies: Record<string, unknown>[] = [];
  const create: MessagesCreateFn = (body) => {
    bodies.push(body);
    return Promise.resolve({ content: [{ type: 'text', text: responseText }] });
  };
  return {
    id: 'stub:recording',
    bodies,
    create,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      await create(toMessagesCreateBody(request));
      return { text: responseText };
    },
  };
}
