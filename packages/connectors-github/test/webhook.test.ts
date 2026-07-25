import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { GithubConnector } from '../src/index.js';

/** Webhook payloads are modelled here; the connector never calls the GitHub API. */

const PERSONA = '1'.repeat(64);
const RECEIVED = '2026-03-03T00:00:00Z';
const connector = new GithubConnector({ persona: PERSONA });
const ctx = { receivedAt: RECEIVED };

const REPO = { full_name: 'acme/api' };
const SENDER = { login: 'dana', id: 4242 };

describe('GitHub and CI webhook deliveries become §2 envelopes', () => {
  it('maps a PR issue comment to pr_comment with the comment time as occurred_at', () => {
    const [envelope] = connector.fromWebhook(
      {
        event: 'issue_comment',
        payload: {
          action: 'created',
          repository: REPO,
          sender: SENDER,
          issue: { number: 41, title: 'Add rate limiting', pull_request: { url: 'https://x/1' } },
          comment: {
            id: 900,
            body: "I'll ship the retry backoff by Friday.",
            created_at: '2026-01-05T10:00:00Z',
            html_url: 'https://github.com/acme/api/pull/41#issuecomment-900',
            author_association: 'MEMBER',
          },
        },
      },
      ctx,
    );
    expect(Envelope.parse(envelope)).toBeTruthy();
    expect(envelope.source).toBe('github');
    expect(envelope.kind).toBe('pr_comment');
    expect(envelope.occurred_at).toBe('2026-01-05T10:00:00Z');
    expect(envelope.received_at).toBe(RECEIVED);
    expect(envelope.actor).toEqual({ label: 'dana', external_id: '4242' });
    expect(envelope.payload['text']).toBe("I'll ship the retry backoff by Friday.");
    expect(envelope.payload['pr_number']).toBe(41);
    expect(envelope.refs).toEqual([
      { kind: 'url', value: 'https://github.com/acme/api/pull/41#issuecomment-900' },
      { kind: 'issue', value: 'acme/api#41' },
    ]);
  });

  it('maps a review comment to pr_comment and records the reviewed path', () => {
    const [envelope] = connector.fromWebhook(
      {
        event: 'pull_request_review_comment',
        payload: {
          action: 'created',
          repository: REPO,
          sender: SENDER,
          pull_request: { number: 42, title: 'Retry backoff' },
          comment: { id: 5, body: 'needs a test', path: 'src/retry.ts', created_at: '2026-01-06T10:00:00Z' },
        },
      },
      ctx,
    );
    expect(envelope.kind).toBe('pr_comment');
    expect(envelope.payload['comment_kind']).toBe('review');
    expect(envelope.payload['path']).toBe('src/retry.ts');
  });

  it('ignores a comment on a plain issue: it is not a PR comment', () => {
    expect(
      connector.fromWebhook(
        {
          event: 'issue_comment',
          payload: {
            action: 'created',
            repository: REPO,
            sender: SENDER,
            issue: { number: 3, title: 'bug' },
            comment: { id: 6, body: 'hi', created_at: '2026-01-06T10:00:00Z' },
          },
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it('maps an opened pull request to pr_opened', () => {
    const [envelope] = connector.fromWebhook(
      {
        event: 'pull_request',
        payload: {
          action: 'opened',
          repository: REPO,
          sender: SENDER,
          pull_request: {
            number: 43,
            title: 'Add retry backoff',
            body: 'Closes #41. I still owe the migration.',
            draft: false,
            created_at: '2026-01-07T08:30:00Z',
            base: { ref: 'main' },
            head: { ref: 'retry-backoff', sha: 'a'.repeat(40) },
            html_url: 'https://github.com/acme/api/pull/43',
          },
        },
      },
      ctx,
    );
    expect(envelope.kind).toBe('pr_opened');
    expect(envelope.occurred_at).toBe('2026-01-07T08:30:00Z');
    expect(envelope.payload['base_ref']).toBe('main');
    expect(envelope.refs.map((r) => r.kind)).toEqual(['url', 'issue', 'commit']);
  });

  it('ignores pull_request actions other than opened', () => {
    for (const action of ['closed', 'synchronize', 'labeled', 'reopened']) {
      expect(
        connector.fromWebhook(
          {
            event: 'pull_request',
            payload: {
              action,
              repository: REPO,
              sender: SENDER,
              pull_request: { number: 43, created_at: '2026-01-07T08:30:00Z' },
            },
          },
          ctx,
        ),
      ).toEqual([]);
    }
  });

  it('maps a push to push, dated by the head commit', () => {
    const [envelope] = connector.fromWebhook(
      {
        event: 'push',
        payload: {
          repository: REPO,
          sender: SENDER,
          ref: 'refs/heads/main',
          before: 'b'.repeat(40),
          after: 'c'.repeat(40),
          forced: false,
          commits: [{ id: 'c'.repeat(40) }, { id: 'd'.repeat(40) }],
          head_commit: {
            id: 'c'.repeat(40),
            message: 'fix: retry backoff',
            timestamp: '2026-01-08T12:00:00Z',
          },
          compare: 'https://github.com/acme/api/compare/bbb...ccc',
        },
      },
      ctx,
    );
    expect(envelope.kind).toBe('push');
    expect(envelope.occurred_at).toBe('2026-01-08T12:00:00Z');
    expect(envelope.payload['commit_count']).toBe(2);
    expect(envelope.payload['ref']).toBe('refs/heads/main');
  });

  it('maps a check_run to the ci source', () => {
    const [envelope] = connector.fromWebhook(
      {
        event: 'check_run',
        payload: {
          action: 'completed',
          repository: REPO,
          sender: SENDER,
          check_run: {
            id: 77,
            name: 'gate-g0',
            status: 'completed',
            conclusion: 'failure',
            head_sha: 'c'.repeat(40),
            started_at: '2026-01-08T12:01:00Z',
            completed_at: '2026-01-08T12:04:00Z',
            html_url: 'https://github.com/acme/api/runs/77',
            app: { slug: 'github-actions' },
          },
        },
      },
      ctx,
    );
    expect(envelope.source).toBe('ci');
    expect(envelope.kind).toBe('check_run');
    expect(envelope.occurred_at).toBe('2026-01-08T12:01:00Z');
    expect(envelope.payload['conclusion']).toBe('failure');
  });

  it('is deterministic: the same delivery yields the same id', () => {
    const delivery = {
      event: 'push' as const,
      payload: {
        repository: REPO,
        sender: SENDER,
        ref: 'refs/heads/main',
        head_commit: { id: 'c'.repeat(40), message: 'x', timestamp: '2026-01-08T12:00:00Z' },
      },
    };
    const [a] = connector.fromWebhook(delivery, ctx);
    const [b] = connector.fromWebhook(delivery, ctx);
    expect(a.id).toBe(b.id);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
