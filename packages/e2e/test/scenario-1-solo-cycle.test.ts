import { beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeConnector } from '@servanda/connectors-claude-code';
import { Extractor, createScriptedModelClient, REFLEXIVE } from '@servanda/extraction';
import { Envelope, type Commitment } from '@servanda/types';
import { commitmentHash } from '@servanda/crypto';
import { runExecutor, type DraftPrArtifact } from '@servanda/executors';
import { execFileSync } from 'node:child_process';
import {
  alice,
  ensureFixtureRepo,
  FIXTURE_HEAD,
  FIXTURE_REPO,
  freshInstall,
  type Install,
} from './support.js';

/**
 * SCENARIO 1 — "Solo: the full magic-moment cycle" (docs/scenarios.md §1).
 *
 * Tuesday 14:20, a Claude Code session on a billing module:
 *   "leave the retry logic as is, I'll add tests once the release ships."
 *
 * Capture hook → extraction (tool-less, typed) → a reflexive commitment → confirmation →
 * executor draft PR → a line in Monday's brief.
 *
 * The chain matters more than any link in it: this is the only test that proves a sentence
 * somebody said out loud reaches a brief without a human retyping it anywhere.
 */

const SPOKEN_AT = '2026-01-06T14:20:00Z';
const UTTERANCE = "leave the retry logic as is, I'll add tests for PaymentRetryService once the release ships";

describe('scenario 1 — solo: from a spoken sentence to a brief line', () => {
  let install: Install;
  let envelopes: Envelope[];
  let pendingId: string;
  let committed: Commitment | null = null;

  beforeAll(async () => {
    install = await freshInstall(SPOKEN_AT);
  });

  it('captures the sentence from a session hook, as data', () => {
    const connector = new ClaudeCodeConnector({ persona: alice.personaId });
    envelopes = connector.fromHookEvent(
      { hook_event_name: 'UserPromptSubmit', prompt: UTTERANCE, session_id: 'session-4412' },
      { occurredAt: SPOKEN_AT, receivedAt: SPOKEN_AT },
    );

    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0]!;
    expect(() => Envelope.parse(envelope)).not.toThrow();
    expect(envelope.kind).toBe('session_utterance');
    expect(envelope.persona).toBe(alice.personaId);
    expect(envelope.occurred_at).toBe(SPOKEN_AT);
    // M-6: the sentence is payload. Nothing in it is read as a command.
    expect(JSON.stringify(envelope.payload)).toContain('PaymentRetryService');
  });

  it('extracts a typed commitment with no tools in the model call', async () => {
    // A scripted response rather than the rule-based stub. Scenario 1 exists to prove the
    // CHAIN — capture → extraction → confirmation → execution → brief — and the chain must not
    // be hostage to a regex table's judgement. (The stub reads "PaymentRetryService" as a
    // counterparty, which is the sort of thing the precision harness exists to surface, and is
    // a human verdict rather than something to assert here.)
    const model = createScriptedModelClient(
      JSON.stringify({
        results: [
          {
            envelope_id: envelopes[0]!.id,
            intent: 'add tests for PaymentRetryService once the release ships',
            owner: 'local_user',
            owner_label: null,
            owed_to: 'none',
            owed_to_label: null,
            due: null,
            confidence: 0.87,
            quote: UTTERANCE,
          },
        ],
      }),
      'scripted:scenario-1',
    );
    const extractor = new Extractor({
      persona: alice.personaId,
      model,
      now: () => install.clock.iso(),
    });

    // §3.4 / M-6: the request carries no tools at all — not a restricted set, none.
    const request = extractor.buildRequest(envelopes);
    expect((request as { tools?: unknown }).tools).toBeUndefined();

    const run = await extractor.extract(envelopes);
    expect(run.rejection).toBeUndefined();
    expect(run.items.length).toBeGreaterThan(0);

    const item = run.items[0]!;
    expect(item.raw.intent.toLowerCase()).toContain('tests');

    // A promise to yourself: owed to nobody, so it never becomes an edge and never leaves
    // the vault. This is what makes solo use complete (M-10).
    expect(item.routed.disposition).toBe(REFLEXIVE);

    pendingId = install.node.queuePendingExtraction(
      alice.personaId,
      {
        v: 'servanda/0.1',
        type: 'commitment',
        intent: item.raw.intent,
        owner: alice.personaId,
        owed_to: null,
        due: item.raw.due ?? null,
        conditions: [],
        evidence_refs: [{ kind: 'envelope', value: item.envelope.id }],
        created_at: install.clock.iso(),
        source: 'extracted',
        confidence: item.raw.confidence ?? 0.5,
      },
      item.envelope.id,
    );
    expect(pendingId.length).toBeGreaterThan(0);
  });

  it('nothing is in the ledger until a human acts (§9.2)', () => {
    // The containment claim, made concrete: a fooled model can produce at most an unconfirmed
    // proposal. Before the confirm below, the ledger is still empty.
    expect(install.vault.listCommitments(alice.personaId)).toHaveLength(0);
    expect(install.vault.listPending(alice.personaId)).toHaveLength(1);
  });

  it('confirms through the §7 confirm tool', () => {
    const out = install.node.confirm({ id: pendingId, decision: 'confirm' });
    expect(out.state).toBe('confirmed');

    const commitments = install.vault.listCommitments(alice.personaId);
    expect(commitments).toHaveLength(1);
    committed = commitments[0]!.commitment;

    expect(committed.owner).toBe(alice.personaId);
    expect(committed.owed_to).toBeNull();
    expect(committed.evidence_refs[0]!.value).toBe(envelopes[0]!.id);
    // The evidence chain runs all the way back to the sentence: the brief can always say
    // "on Tuesday you said…" and point at the thing that was actually said.
    expect(committed.evidence_refs[0]!.kind).toBe('envelope');
  });

  it('carries no due date, and so never escalates on time (§3.1)', () => {
    // "I'll add tests once the release ships" is conditional, not dated. §3.1: undated
    // commitments MUST NOT time-escalate. They rank by age × blocking instead.
    expect(committed!.due).toBeNull();
    install.clock.advanceDays(120);
    expect(install.node.escalatable(alice.personaId)).toHaveLength(0);
  });

  it('the executor turns the promise into a draft PR, not a reminder', async () => {
    // Scenario 1's inversion: "not a reminder — finished work awaiting approval." A reminder
    // costs attention; a ready PR costs one review.
    const outcome = await runExecutor({
      executorClass: 'tests',
      commitment: {
        v: 'servanda/0.1',
        type: 'commitment',
        owner: alice.personaId,
        owed_to: null,
        due: null,
        conditions: [],
        created_at: committed!.created_at,
        source: 'extracted',
        confidence: committed!.confidence,
        // M-7: the executor references the promise by hash and never holds its plaintext.
        commitment_hash: commitmentHash(committed!),
      },
      target: { kind: 'source-file', path: 'src/payments.ts' },
      persona: alice.personaId,
      repo: { path: ensureFixtureRepo(), baseBranch: 'main' },
      intentForReviewer: committed!.intent,
      now: install.clock.iso(),
    });

    expect(outcome.kind).toBe('artifact');
    const artifact = (outcome as { artifact: DraftPrArtifact }).artifact;

    // Draft, always. The executor never merges and never signs (M-13): automation acts under a
    // persona, never as one.
    expect(artifact.draft).toBe(true);
    expect((artifact as unknown as { sig?: unknown }).sig).toBeUndefined();

    // A new class starts at the floor, so this waits for a human no matter how good it is.
    expect(artifact.autonomy.level).toBe('draft-for-review');

    expect(artifact.changes.length).toBeGreaterThan(0);
    for (const change of artifact.changes) {
      // The `tests` class may only write under test/. Capability, not convention.
      expect(change.path.startsWith('test/')).toBe(true);
    }
  });

  it('leaves the fixture repository untouched', () => {
    // Executors touch only fixture repos, and even then they produce a diff rather than mutate
    // the tree. If this drifts, the sandbox has stopped containing anything.
    const head = execFileSync('git', ['-C', FIXTURE_REPO, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(head).toBe(FIXTURE_HEAD);
    expect(
      execFileSync('git', ['-C', FIXTURE_REPO, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).toBe('');
  });

  it('surfaces as a brief line naming what was said', () => {
    const brief = install.node.brief({ persona: null });
    expect(brief.slots.length).toBeGreaterThan(0);

    const slot = brief.slots[0]!;
    expect(slot.headline.toLowerCase()).toContain('tests');
    // M-21: the slot names an act, not a word. `tool` may be null for an act v0 binds to
    // nothing — what must never appear is display wording.
    expect(slot.primary_action === null || typeof slot.primary_action.act === 'string').toBe(true);
    if (slot.primary_action !== null) {
      expect(Object.keys(slot.primary_action).sort()).toEqual(['act', 'args', 'tool']);
    }

    // A reflexive commitment has no counterparty to display, and the loop is one the user owes.
    const loops = install.node.openLoops({ view: 'owe', persona: null, limit: 10 });
    expect(loops.items.length).toBeGreaterThan(0);
    expect(loops.items[0]!.counterparty).toBeNull();
  });
});
