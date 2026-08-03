import { describe, expect, it } from 'vitest';
import { buildUserContent } from '../src/prompt.js';
import { createStubModelClient } from '../src/stub.js';

/**
 * Text that carries promise language and is not a promise.
 *
 * §7 offers `--dry-run` as the way to see "what extraction actually finds" before spending a
 * cent, so the stub is the first — and for a cost-shy person the only — picture anyone gets of
 * this system's judgement. Poor recall there is declared and harmless: a miss shows up as an
 * empty report and costs nothing.
 *
 * A false positive is not symmetric with a miss. A commitment the person never made has to be
 * *disowned*, and a negated one is the worst case in the class: the register ends up holding
 * the exact opposite of what was said. "I will not be sending the quote by Friday" carries
 * every token a genuine promise carries — first person, future modal, a named counterparty, a
 * resolvable deadline — and one word that reverses all of them.
 */

const client = createStubModelClient();

async function extract(text: string): Promise<{ intent: string; confidence: number }[]> {
  const envelope = {
    id: 'e'.repeat(64),
    source: 'transcript',
    kind: 'session_utterance',
    occurred_at: '2026-08-01T10:00:00Z',
    actor: { label: 'local-user' },
    payload: { text },
  } as unknown as Parameters<typeof buildUserContent>[0][number];
  const response = await client.complete({
    system: '',
    messages: [{ role: 'user', content: buildUserContent([envelope]) }],
  });
  return (JSON.parse(response.text) as { results: { intent: string; confidence: number }[] })
    .results;
}

describe('a refusal is not a commitment', () => {
  it('extracts nothing from a negated undertaking', async () => {
    const refusals = [
      'I will not be sending the quote to Maria by Friday.',
      'I will never agree to that deadline.',
      "I'll no longer be handling the invoices for Ivan.",
      "I'm not going to write the migration, Ivan is.",
      "I won't be at the review on Monday.",
      'I will not do the migration this week.',
    ];
    for (const text of refusals) {
      expect(await extract(text), text).toHaveLength(0);
    }
  });

  it('still extracts the promise the refusal was shaped like', async () => {
    const results = await extract('I will send Maria the quote by friday.');
    expect(results).toHaveLength(1);
    expect(results[0]?.confidence).toBeGreaterThan(0.5);
  });

  it('does not let a negation elsewhere in the sentence suppress a real promise', async () => {
    // The guard is about the undertaking, not about the word "not" appearing anywhere near it.
    const results = await extract('I will send the quote, though it is not finished yet.');
    expect(results).toHaveLength(1);
  });
});
