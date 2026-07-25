import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GithubConnector } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FIXTURE = resolve(ROOT, 'fixtures/archaeology-repo/repo');

const WORK = '2'.repeat(64);
const CLIENT = '3'.repeat(64);
const CTX = { receivedAt: '2026-04-04T00:00:00Z', referenceTime: '2026-01-01T00:00:00Z' };

beforeAll(() => {
  if (!existsSync(resolve(FIXTURE, '.git'))) {
    execFileSync('bash', [resolve(ROOT, 'fixtures/archaeology-repo/setup.sh')], { stdio: 'inherit' });
  }
});

/**
 * M-5 — "No org-context mixing in any pipeline."
 *
 * §2 states the connector-side obligation directly: "a connector instance is bound to
 * exactly one persona at registration." This suite pins the *shape* that makes mixing
 * impossible rather than merely discouraged: the persona is a construction-time parameter,
 * so there is no call site at which a caller could ask for someone else's envelope.
 */
describe('M-5: a connector instance is bound to exactly one persona at registration', () => {
  it('takes the persona at construction and exposes it', () => {
    expect(new GithubConnector({ persona: WORK }).persona).toBe(WORK);
  });

  it('rejects anything that is not a persona id, at construction', () => {
    for (const bad of ['', 'not-hex', 'A'.repeat(64), '4'.repeat(63), '4'.repeat(65)]) {
      expect(() => new GithubConnector({ persona: bad })).toThrow();
    }
  });

  it('stamps every archaeology envelope with the bound persona', () => {
    const envelopes = new GithubConnector({ persona: WORK }).archaeology({ repoPath: FIXTURE, ...CTX });
    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) expect(envelope.persona).toBe(WORK);
  });

  it('stamps every webhook envelope with the bound persona, ignoring any persona in the body', () => {
    const [envelope] = new GithubConnector({ persona: CLIENT }).fromWebhook(
      {
        event: 'push',
        payload: {
          persona: WORK,
          repository: { full_name: 'acme/api' },
          sender: { login: 'dana', id: 1 },
          head_commit: { id: 'abcdef1', message: 'x', timestamp: '2026-01-08T12:00:00Z' },
        },
      },
      { receivedAt: CTX.receivedAt },
    );
    expect(envelope.persona).toBe(CLIENT);
  });

  it('gives two personas disjoint envelope sets over the identical repository state', () => {
    const work = new GithubConnector({ persona: WORK }).archaeology({ repoPath: FIXTURE, ...CTX });
    const client = new GithubConnector({ persona: CLIENT }).archaeology({ repoPath: FIXTURE, ...CTX });

    // Same findings, but no envelope id is shared: nothing downstream can merge the two
    // sets by identity and silently produce a mixed-context pipeline.
    expect(work.map((e) => e.kind)).toEqual(client.map((e) => e.kind));
    const shared = new Set(work.map((e) => e.id)).intersection(new Set(client.map((e) => e.id)));
    expect([...shared]).toEqual([]);
  });

  it('offers no API that accepts a persona per call', () => {
    const connector = new GithubConnector({ persona: WORK });
    // The connector's whole public surface: neither method has a persona parameter.
    expect(connector.archaeology.length).toBe(1);
    expect(connector.fromWebhook.length).toBe(2);
  });
});
