import type { OpenLoopItem, VerificationLevel } from '@servanda/types';
import { COPY } from './copy.js';
import type { SealView } from './seal.js';
import { sealFor } from './seal.js';
import type { ConsequenceTone, PartyView } from './view.js';
import { consequenceFor, partyFor } from './view.js';

/**
 * The team surface — doctrine surface 6: "the blocking graph as auto-standup; a 40-second
 * read; built only from scope-published edges (M-4)."
 *
 * Two rules shape every decision in this file, and both are the same rule seen from two
 * sides.
 *
 * **M-4: visibility follows participation, never membership.** The input to this view is
 * not "everything the team's members have promised". It is the list of things a *party*
 * chose to share, by a signed act, into *this* scope. `buildTeam` therefore starts by
 * throwing away everything that was not shared here — and the filter is the first thing it
 * does, so there is no code path in which an unshared promise is ever formatted, counted,
 * or reached. Sharing into another scope grants nothing here either (§5.3 M-4c: no
 * inheritance).
 *
 * **M-11: no reputation.** The view has no per-person anything: no counts, no rates, no
 * ordering by who is slowest, no field whose value is a number attached to a name. What it
 * reports is what is shared and what that holds up — the sentence is always about the work.
 * "Your standup writes itself", never "see who is behind". This is not tone; a per-person
 * tally computed for display is a fulfillment statistic, and M-11 forbids computing one.
 */

/** The §5.2 publish act, reduced to what a reader of this surface needs. */
export interface SharedInto {
  /** The scope key it was shared into. Compared exactly: no inheritance (M-4c). */
  readonly scope: string;
  /** The party who shared it. Only a party to a promise may (§5.2). */
  readonly by: string;
}

export interface TeamPublication {
  /** The promise, as §7 renders one. Hashes and states; never the words. */
  readonly item: OpenLoopItem;
  /**
   * Null means nobody shared it. A null here is not "hidden for now" — it is a promise
   * this surface has no business knowing about at all (M-4b).
   */
  readonly shared: SharedInto | null;
  /** The other party, since a §7 item names one counterparty and a shared promise has two. */
  readonly otherParty?: { readonly display: string | null; readonly level: VerificationLevel } | null;
  /** What this holds up, in the team's own words. Work items, never people. */
  readonly blocks?: readonly string[];
}

export interface TeamInput {
  readonly scope: { readonly key: string; readonly label: string };
  readonly publications: readonly TeamPublication[];
}

export interface TeamEntryView {
  readonly id: string;
  /** What. The words as shared. */
  readonly what: string;
  /** Between whom — both sides, each with the evidence behind its name (M-12). */
  readonly between: readonly PartyView[];
  readonly betweenLine: string;
  /** What happens if nothing happens. A fact about a date, never about a person. */
  readonly ifNothingHappens: string;
  readonly tone: ConsequenceTone;
  readonly seal: SealView;
  /** What it holds up. Work, never a name. */
  readonly blocks: readonly string[];
  readonly blocksLine: string;
}

export interface TeamView {
  readonly heading: string;
  readonly lede: string;
  readonly scopeLabel: string;
  readonly empty: string;
  readonly note: string;
  readonly entries: readonly TeamEntryView[];
}

/**
 * The visibility filter, alone and named, so it can be pointed at in a test and so nothing
 * downstream has to remember it. Everything else in this file operates on its output.
 */
export function sharedWith(scopeKey: string, publications: readonly TeamPublication[]): TeamPublication[] {
  // An unset scope is not a wildcard. Getting this backwards is the shape the M-4 bug
  // actually takes in practice: an empty filter that quietly matches everything.
  if (scopeKey.length === 0) return [];
  return publications.filter((p) => p.shared !== null && p.shared.scope === scopeKey);
}

function partiesOf(publication: TeamPublication): PartyView[] {
  const parties: PartyView[] = [];
  const first = partyFor(publication.item.counterparty, publication.item.verification_level);
  if (first !== null) parties.push(first);
  const other = publication.otherParty;
  if (other !== undefined && other !== null && other.display !== null) {
    const second = partyFor({ value: other.display, origin: 'attested' }, other.level);
    if (second !== null) parties.push(second);
  }
  return parties;
}

function entryFor(publication: TeamPublication, now: string): TeamEntryView {
  const item = publication.item;
  // `false`, and not a role lookup: the team surface has no viewer role to read. M-4 makes this
  // a list of promises PARTIES chose to publish into a scope, and the person reading it is
  // usually neither of them — so "their date passed", which asserts the reader is the one owed,
  // would be false for almost every reader. The owner-framing describes the promise rather than
  // the reader's position, which is what a standup is. This is what the old `isWaiting(item)`
  // already evaluated to here (a published item is an edge, never an expectation); it is written
  // out because it was an accident and is now a decision.
  const consequence = consequenceFor(item, now, false);
  const between = partiesOf(publication);
  const blocks = publication.blocks ?? [];
  return {
    id: item.id,
    what: item.intent_or_expect,
    between,
    betweenLine:
      between.length === 2
        ? COPY.team.between(between[0]?.display ?? '', between[1]?.display ?? '')
        : (between[0]?.display ?? COPY.party.unknown),
    ifNothingHappens: consequence.text,
    tone: consequence.tone,
    seal: sealFor(item.state),
    blocks,
    blocksLine: blocks.length === 0 ? COPY.team.blocksNothing : COPY.team.blocks(blocks.join(', ')),
  };
}

export function buildTeam(input: TeamInput, now: string): TeamView {
  // The filter runs first and nothing downstream sees what it removed.
  const visible = sharedWith(input.scope.key, input.publications);
  return {
    heading: COPY.team.heading,
    lede: COPY.team.lede,
    scopeLabel: input.scope.label,
    empty: COPY.team.empty,
    note: COPY.team.note,
    // Order is the order things were shared. Not by urgency, not by person, not sortable:
    // any ordering keyed on who owes what is a ranking of people wearing a different hat.
    entries: visible.map((publication) => entryFor(publication, now)),
  };
}

/** An empty team surface, for the surfaces that are not the team surface. */
export const NO_TEAM: TeamInput = { scope: { key: '', label: '' }, publications: [] };
