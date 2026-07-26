import type { ReactionEvent } from '../reaction.js';
import type { PersonaDirectory } from '../ports.js';
import { quote } from '../quote.js';
import type { Speaker, Utterance } from '../utterance.js';

/**
 * A review-comment webhook, of the GitHub shape. Scenario 4 lives here.
 *
 * Mila writes "I'll pull staging data for repro by Wednesday" in a review comment on
 * Stefan's pull request. Extraction on a review comment is cross-person, so it is
 * confirm-first (§3.4): her agent asks *her*, in the same window, and one tap turns it into
 * her own record. Stefan is never gestured at — his half arrives batched in his next brief.
 *
 * As with the chat adapter: the payload is modelled, nothing is fetched, and every string a
 * person wrote arrives through `quote`.
 */

export interface PrUser {
  readonly login: string;
  readonly id: number;
}

export interface PrComment {
  readonly id: number;
  readonly body: string;
  readonly user: PrUser;
  readonly html_url: string;
  readonly created_at: string;
}

export interface PullRequestRef {
  readonly number: number;
  readonly html_url: string;
  /** Whose pull request it is. The counterparty when somebody else comments on it. */
  readonly user: PrUser;
}

export interface ReviewCommentWebhook {
  readonly action: 'created';
  readonly comment: PrComment;
  readonly pull_request: PullRequestRef;
  readonly repository: { readonly full_name: string };
}

/** A reaction added to an existing review comment — the in-situ confirm gesture. */
export interface CommentReactionWebhook {
  readonly action: 'created';
  readonly reaction: { readonly content: string; readonly user: PrUser };
  readonly comment: PrComment;
  readonly pull_request: PullRequestRef;
  readonly repository: { readonly full_name: string };
}

export function prExternalId(user: PrUser): string {
  return `github:${user.id}`;
}

function speakerOf(user: PrUser, directory: PersonaDirectory): Speaker {
  const known = directory.lookup(prExternalId(user));
  return {
    display: quote(user.login),
    externalId: prExternalId(user),
    personaId: known?.personaId ?? null,
    verification: known?.verification ?? '0',
  };
}

export interface PrContext {
  readonly directory: PersonaDirectory;
  readonly pendingId?: string | null;
}

export function prUtterance(
  comment: PrComment,
  pullRequest: PullRequestRef,
  context: PrContext,
): Utterance {
  const speaker = speakerOf(comment.user, context.directory);
  // A promise made in review is owed to whoever is waiting on the review: the author of the
  // pull request, unless they are the one who wrote the comment.
  const owedTo =
    pullRequest.user.id === comment.user.id ? null : speakerOf(pullRequest.user, context.directory);
  return {
    place: 'pr-comment',
    ref: { kind: 'url', value: comment.html_url },
    speaker,
    text: quote(comment.body),
    occurredAt: comment.created_at,
    pendingId: context.pendingId ?? null,
    owedTo,
  };
}

export function reviewCommentUtterance(hook: ReviewCommentWebhook, context: PrContext): Utterance {
  return prUtterance(hook.comment, hook.pull_request, context);
}

/**
 * A reaction on a review comment, as a gesture. Null when the reactor is unknown to this
 * node, for the same reason as in chat: a gesture nobody can be attributed to is not one.
 */
export function commentReactionEvent(
  hook: CommentReactionWebhook,
  context: PrContext,
): ReactionEvent | null {
  const reactor = context.directory.lookup(prExternalId(hook.reaction.user));
  if (reactor === null) return null;
  return {
    reaction: hook.reaction.content,
    by: reactor.personaId,
    utterance: prUtterance(hook.comment, hook.pull_request, context),
  };
}
