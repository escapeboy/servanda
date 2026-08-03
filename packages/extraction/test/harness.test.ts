import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, runHarness } from '../src/index.js';
import { transcriptFixture, userLine } from './fixtures.js';

const NOW = new Date('2026-07-25T12:00:00Z');

const LINES = [
  userLine('I will finish the migration guide and send it to Maria by Friday.'),
  userLine('Ivan said he would review the PR before the release.', '2026-07-20T09:08:00Z'),
  userLine('Could you check whether the cache is warm? Just wondering about it.', '2026-07-20T09:09:00Z'),
];

describe('precision harness', () => {
  it('runs end to end on the stub path and writes a well-formed report', async () => {
    const root = transcriptFixture(LINES);
    const out = join(root, 'precision-report.md');

    const result = await runHarness({ dryRun: true, root, out, now: NOW, days: 30 });

    expect(existsSync(out)).toBe(true);
    const markdown = readFileSync(out, 'utf8');
    expect(markdown).toBe(result.markdown);
    expect(markdown).toContain('# Servanda extraction — precision report');
    expect(markdown).toContain('Nothing in this report has been committed to anything');
    expect(markdown).toContain('The precision verdict is yours');
    expect(markdown).toContain('## Totals');
    expect(markdown).toContain('Envelopes produced');
    expect(markdown).toContain('Extraction rate');
    expect(markdown).toContain('| Ref | Correct? |');
    expect(result.mode).toBe('stub');
    expect(result.liveRunSkippedReason).toBe('--dry-run was requested');
    expect(result.rows.length).toBeGreaterThan(0);
  });

  /**
   * The report is the most quotable document this repository produces about its user: thirty
   * days of what they typed to their agent, verbatim, including whatever they pasted into a
   * prompt. §7 has them run it into a working directory rather than a vault, and it is not
   * encrypted there — so the mode is the only thing that makes it theirs.
   */
  it('writes the report readable only by its owner', async () => {
    const root = transcriptFixture(LINES);
    const out = join(root, 'precision-report.md');

    await runHarness({ dryRun: true, root, out, now: NOW, days: 30 });

    expect(readFileSync(out, 'utf8')).toContain('send it to Maria by Friday');
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('puts every result in the pending queue and confirms none of them', async () => {
    const root = transcriptFixture(LINES);
    const result = await runHarness({ dryRun: true, root, now: NOW });
    expect(result.queue.size).toBe(result.rows.length);
    expect(result.queue.list('pending')).toHaveLength(result.rows.length);
    expect(result.queue.list('confirmed')).toHaveLength(0);
  });

  it('carries the verbatim quote, its context, and where to look it up', async () => {
    const root = transcriptFixture(LINES);
    const result = await runHarness({ dryRun: true, root, now: NOW });
    for (const row of result.rows) {
      expect(row.quote.length).toBeGreaterThan(0);
      expect(row.context).toContain(row.quote.slice(0, 20));
      expect(row.transcript).toContain('session-1.jsonl');
      expect(row.transcriptLine).toBeGreaterThan(0);
      expect(row.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.confidence).toBeGreaterThanOrEqual(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('reports both a first-person commitment and a reported one, routed differently', async () => {
    const root = transcriptFixture(LINES);
    const result = await runHarness({ dryRun: true, root, now: NOW });
    const dispositions = new Set(result.rows.map((r) => r.disposition));
    expect(dispositions.has('expectation-only')).toBe(true);
    expect([...dispositions].some((d) => d !== 'expectation-only')).toBe(true);
  });

  it('writes no report file when no output path is given', async () => {
    const root = transcriptFixture(LINES);
    const result = await runHarness({ dryRun: true, root, now: NOW });
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'precision-report.md'))).toBe(false);
  });

  it('says plainly when the live path was not exercised', async () => {
    const root = transcriptFixture(LINES);
    const result = await runHarness({ root, now: NOW, apiKey: undefined });
    expect(result.mode).toBe('stub');
    expect(result.liveRunSkippedReason).toBe('ANTHROPIC_API_KEY is not set in the environment');
    expect(result.markdown).toContain('not exercised');
  });

  it('renders a report even when the window is empty', async () => {
    const root = transcriptFixture(LINES);
    const result = await runHarness({ dryRun: true, root, now: new Date('2027-01-01T00:00:00Z') });
    expect(result.rows).toHaveLength(0);
    expect(result.markdown).toContain('No commitments were extracted from this window.');
  });

  it('parses the flags the gate depends on', () => {
    expect(parseArgs(['--dry-run', '--days', '7', '--max-transcripts', '3'])).toEqual({
      dryRun: true,
      days: 7,
      maxTranscripts: 3,
    });
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--days'])).toThrow(/requires a value/);
  });
});
