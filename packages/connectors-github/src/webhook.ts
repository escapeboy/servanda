import { Rfc3339 } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import { MAX_PAYLOAD_TEXT, MAX_REF, clip, compact, label, sealEnvelope } from './envelope.js';

/**
 * GitHub / CI webhook deliveries → §2 envelopes.
 *
 * A delivery is `X-GitHub-Event` plus a JSON body. The body is entirely attacker-shaped: a
 * PR comment is written by whoever opened the PR. Two consequences run through this file:
 *
 *  1. Only SCALARS are lifted out of the body, by explicit path. Nothing nested is copied
 *     through, so a body nested a thousand deep produces a flat payload or nothing at all.
 *  2. `source` and `kind` come from the closed sets below and are never read out of the
 *     body. That is what makes M-6 mechanical rather than aspirational.
 */

export const WEBHOOK_KINDS = ['pr_comment', 'pr_opened', 'push', 'check_run'] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export const WEBHOOK_SOURCES = ['github', 'ci'] as const;

export interface WebhookDelivery {
  /** The `X-GitHub-Event` header value. */
  readonly event: string;
  readonly payload: unknown;
}

export interface WebhookContext {
  /** §2 `received_at` — injected; the envelope path reads no clock. */
  readonly receivedAt: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? clip(v, MAX_PAYLOAD_TEXT) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** An RFC 3339 instant or nothing. A connector with no source timestamp emits no envelope. */
function when(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : undefined;
  return s !== undefined && Rfc3339.safeParse(s).success ? s : undefined;
}

/** Only http(s) reaches a `url` ref; a `javascript:` "url" is not a location. */
function url(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  return /^https?:\/\//u.test(s) ? clip(s, MAX_REF) : undefined;
}

function sha(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : undefined;
  return s !== undefined && /^[0-9a-f]{7,40}$/u.test(s) ? s : undefined;
}

function actorOf(payload: Obj): { label: string; external_id?: string } {
  const sender = obj(payload['sender']);
  const login = sender === undefined ? undefined : str(sender['login']);
  const id = sender === undefined ? undefined : num(sender['id']);
  return compact({
    label: label(login ?? 'unknown'),
    external_id: id === undefined ? undefined : String(id),
  }) as { label: string; external_id?: string };
}

function repoName(payload: Obj): string | undefined {
  const repo = obj(payload['repository']);
  return repo === undefined ? undefined : str(repo['full_name']);
}

interface Built {
  readonly source: (typeof WEBHOOK_SOURCES)[number];
  readonly kind: WebhookKind;
  readonly occurredAt: string;
  readonly payload: Obj;
  readonly refs: { kind: 'url' | 'commit' | 'issue' | 'message' | 'file'; value: string }[];
}

function buildPrComment(event: string, p: Obj): Built | undefined {
  if (str(p['action']) !== 'created') return undefined;
  const comment = obj(p['comment']);
  if (comment === undefined) return undefined;
  const occurredAt = when(comment['created_at']);
  if (occurredAt === undefined) return undefined;

  const isReview = event === 'pull_request_review_comment';
  const container = isReview ? obj(p['pull_request']) : obj(p['issue']);
  if (container === undefined) return undefined;
  // An `issue_comment` on a plain issue is not a PR comment. Narrow: skip it.
  if (!isReview && obj(container['pull_request']) === undefined) return undefined;

  const number = num(container['number']);
  const repo = repoName(p);
  const body = str(comment['body']);
  const htmlUrl = url(comment['html_url']);

  const refs: Built['refs'] = [];
  if (htmlUrl !== undefined) refs.push({ kind: 'url', value: htmlUrl });
  if (repo !== undefined && number !== undefined) {
    refs.push({ kind: 'issue', value: clip(`${repo}#${number}`, MAX_REF) });
  }

  return {
    source: 'github',
    kind: 'pr_comment',
    occurredAt,
    payload: compact({
      repo,
      pr_number: number,
      comment_id: num(comment['id']),
      comment_kind: isReview ? 'review' : 'issue',
      author_association: str(comment['author_association']),
      path: isReview ? str(comment['path']) : undefined,
      title: str(container['title']),
      text: body,
      html_url: htmlUrl,
    }),
    refs,
  };
}

function buildPrOpened(p: Obj): Built | undefined {
  if (str(p['action']) !== 'opened') return undefined;
  const pr = obj(p['pull_request']);
  if (pr === undefined) return undefined;
  const occurredAt = when(pr['created_at']);
  if (occurredAt === undefined) return undefined;

  const base = obj(pr['base']);
  const head = obj(pr['head']);
  const repo = repoName(p);
  const number = num(pr['number']);
  const htmlUrl = url(pr['html_url']);
  const headSha = head === undefined ? undefined : sha(head['sha']);

  const refs: Built['refs'] = [];
  if (htmlUrl !== undefined) refs.push({ kind: 'url', value: htmlUrl });
  if (repo !== undefined && number !== undefined) {
    refs.push({ kind: 'issue', value: clip(`${repo}#${number}`, MAX_REF) });
  }
  if (headSha !== undefined) refs.push({ kind: 'commit', value: headSha });

  return {
    source: 'github',
    kind: 'pr_opened',
    occurredAt,
    payload: compact({
      repo,
      pr_number: number,
      title: str(pr['title']),
      text: str(pr['body']),
      draft: bool(pr['draft']),
      base_ref: base === undefined ? undefined : str(base['ref']),
      head_ref: head === undefined ? undefined : str(head['ref']),
      head_sha: headSha,
      html_url: htmlUrl,
    }),
    refs,
  };
}

function buildPush(p: Obj): Built | undefined {
  const head = obj(p['head_commit']);
  if (head === undefined) return undefined;
  const occurredAt = when(head['timestamp']);
  if (occurredAt === undefined) return undefined;

  const headSha = sha(head['id']);
  const compareUrl = url(p['compare']);
  const commits = p['commits'];

  const refs: Built['refs'] = [];
  if (compareUrl !== undefined) refs.push({ kind: 'url', value: compareUrl });
  if (headSha !== undefined) refs.push({ kind: 'commit', value: headSha });

  return {
    source: 'github',
    kind: 'push',
    occurredAt,
    payload: compact({
      repo: repoName(p),
      ref: str(p['ref']),
      before: sha(p['before']),
      after: sha(p['after']),
      forced: bool(p['forced']),
      head_commit_id: headSha,
      text: str(head['message']),
      commit_count: Array.isArray(commits) ? commits.length : undefined,
      compare_url: compareUrl,
    }),
    refs,
  };
}

function buildCheckRun(p: Obj): Built | undefined {
  const run = obj(p['check_run']);
  if (run === undefined) return undefined;
  const occurredAt = when(run['started_at']) ?? when(run['completed_at']);
  if (occurredAt === undefined) return undefined;

  const headSha = sha(run['head_sha']);
  const htmlUrl = url(run['html_url']);
  const app = obj(run['app']);

  const refs: Built['refs'] = [];
  if (htmlUrl !== undefined) refs.push({ kind: 'url', value: htmlUrl });
  if (headSha !== undefined) refs.push({ kind: 'commit', value: headSha });

  return {
    source: 'ci',
    kind: 'check_run',
    occurredAt,
    payload: compact({
      repo: repoName(p),
      check_run_id: num(run['id']),
      text: str(run['name']),
      status: str(run['status']),
      conclusion: str(run['conclusion']),
      completed_at: when(run['completed_at']),
      head_sha: headSha,
      app_slug: app === undefined ? undefined : str(app['slug']),
      html_url: htmlUrl,
    }),
    refs,
  };
}

/** Zero or one envelope. An unmodelled event, or one with no usable timestamp, is nothing. */
export function envelopeFromWebhook(
  delivery: WebhookDelivery,
  persona: string,
  ctx: WebhookContext,
): Envelope | undefined {
  const p = obj(delivery.payload);
  if (p === undefined) return undefined;

  let built: Built | undefined;
  switch (delivery.event) {
    case 'issue_comment':
    case 'pull_request_review_comment':
      built = buildPrComment(delivery.event, p);
      break;
    case 'pull_request':
      built = buildPrOpened(p);
      break;
    case 'push':
      built = buildPush(p);
      break;
    case 'check_run':
      built = buildCheckRun(p);
      break;
    default:
      return undefined;
  }
  if (built === undefined) return undefined;

  return sealEnvelope({
    v: 'servanda/0.1',
    type: 'envelope',
    source: built.source,
    kind: built.kind,
    occurred_at: built.occurredAt,
    received_at: ctx.receivedAt,
    actor: actorOf(p),
    payload: built.payload,
    refs: built.refs,
    persona,
  });
}
