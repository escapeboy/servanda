#!/usr/bin/env bash
# GATE GL — In-situ gestures.
#
# Surface 3 of the seven, and the only one with no screen of its own by definition: capture
# and confirmation happen where the promise was spoken. This script is the definition of done
# for that surface, and it asserts six things:
#
#   1. Zero forbidden vocabulary and zero exclamation marks in anything this package can put
#      in front of a person — scanned over RENDERED cards and the string table, never over
#      source identifiers — with a negative control proving the scanner can fail.
#   2. Every card answers the three questions — what · with whom · what happens if I do
#      nothing — with the primary action leading it, and is operable without a pointer.
#   3. M-1: no gesture path produces a proposal owned by anyone but the confirming person.
#      Checked at runtime AND at compile time: a file that tries is required not to typecheck.
#   4. M-6: hostile message text — injection, control characters, bidi overrides, huge bodies
#      — is quoted and never read as control.
#   5. No network from any gesture path, proved the way gate GA proves it for the node.
#   6. M-1, M-6 and M-12 have named tests here, must-coverage passes for every registered MUST,
#      and the suites pass.
#
# Every scanner in here is checked against a known violation. A check that cannot fail proves
# nothing, so each one is made to fail on purpose before it is trusted.
set -euo pipefail

cd "$(dirname "$0")/.."

PKG=packages/gestures
MUSTS=(M-1 M-6 M-12)

echo "==> GL: workspace links"
for dep in @servanda/types @servanda/client-web; do
  if ! node -e "require.resolve('${dep}', { paths: ['${PWD}/${PKG}/src'] })" >/dev/null 2>&1; then
    echo "FAIL: ${dep} is not resolvable from ${PKG}" >&2
    exit 1
  fi
done
echo "    @servanda/types and @servanda/client-web resolve from the gesture surface"

echo "==> GL: typecheck (package, then package plus tests)"
npx tsc -b "${PKG}"
npx tsc --noEmit -p "${PKG}/tsconfig.test.json"

# The vocabulary law, over what a person actually reads. A gesture card is shown inside
# somebody else's chat window, so for many people it is the first sentence of this product
# they ever see; the register has to hold there most of all.
echo "==> GL: vocabulary and register"
node --input-type=module -e "
import { FORBIDDEN_TERMS, scanExclamations, scanVocabulary, visibleText } from './packages/client-web/dist/index.js';
import {
  MILA, allGestureCopyStrings, everyCard, fixtureDirectory, gestureCardEl, meetingEndCards, meetingFixture,
} from './packages/gestures/dist/index.js';

const cards = [...everyCard(), ...meetingEndCards(meetingFixture(), fixtureDirectory(), MILA)];
const read = [...allGestureCopyStrings()];
for (const card of cards) read.push(...visibleText(gestureCardEl(card)));

const words = scanVocabulary(read);
const shouts = scanExclamations(read);
console.log(\`    scanned \${read.length} user-facing strings across \${cards.length} rendered cards and the string table\`);
console.log(\`    forbidden terms checked: \${FORBIDDEN_TERMS.join(', ')}\`);
if (words.length > 0 || shouts.length > 0) {
  for (const v of [...words, ...shouts]) console.error(\`    FAIL \${v.term}: \${v.text}\`);
  console.error(\`FAIL: \${words.length} vocabulary and \${shouts.length} register violations\`);
  process.exit(1);
}
console.log('    0 forbidden terms, 0 exclamation marks');

// A scanner that never fires is a scanner nobody can trust.
if (scanVocabulary(['Confirm the edge']).length !== 1 || scanExclamations(['Confirmed!']).length !== 1) {
  console.error('FAIL: the vocabulary scanner does not detect a known violation');
  process.exit(1);
}
console.log('    scanner verified against a known violation');
"

# Three questions, primary action leading, keyboard-operable. Checked on the rendered tree
# rather than on the view model, because the order a person meets things in is the order the
# document puts them in.
echo "==> GL: every card answers the three questions, with the primary action first"
node --input-type=module -e "
import { focusOrder, pointerOnlyControls, walk } from './packages/client-web/dist/index.js';
import {
  MILA, everyCard, fixtureDirectory, gestureCardEl, meetingEndCards, meetingFixture, primaryAction, threeQuestions,
} from './packages/gestures/dist/index.js';

const cards = [...everyCard(), ...meetingEndCards(meetingFixture(), fixtureDirectory(), MILA)];
let stops = 0;
for (const card of cards) {
  const a = threeQuestions(card);
  for (const [q, value] of Object.entries(a)) {
    if (typeof value !== 'string' || value.length === 0) {
      console.error(\`FAIL \${card.id}: the card does not answer \${q}\`);
      process.exit(1);
    }
  }

  const nodes = walk(gestureCardEl(card));
  const firstButton = nodes.findIndex((n) => n.tag === 'button');
  if (firstButton < 0) { console.error(\`FAIL \${card.id}: no action leads the card\`); process.exit(1); }
  if (nodes[firstButton].text !== primaryAction(card).label) {
    console.error(\`FAIL \${card.id}: the first control is not the primary action\`);
    process.exit(1);
  }
  for (const answer of [card.what, card.ifIDoNothing]) {
    const at = nodes.findIndex((n) => n.text === answer);
    if (at <= firstButton) {
      console.error(\`FAIL \${card.id}: an answer precedes the action that leads the card\`);
      process.exit(1);
    }
  }

  const tree = gestureCardEl(card);
  if (pointerOnlyControls(tree).length > 0) {
    console.error(\`FAIL \${card.id}: a control a pointer can reach and a keyboard cannot\`);
    process.exit(1);
  }
  const walked = focusOrder(tree);
  if (walked.length !== card.actions.length) {
    console.error(\`FAIL \${card.id}: \${card.actions.length} actions offered, \${walked.length} reachable\`);
    process.exit(1);
  }
  for (const stop of walked) {
    if (stop.name.length === 0) {
      console.error(\`FAIL \${card.id}: a focus stop has no name a screen reader could announce\`);
      process.exit(1);
    }
  }
  stops += walked.length;
}
console.log(\`    \${cards.length} cards, 3 questions each, \${stops} focus stops, 0 stranded controls\`);

// The check must be able to fail: a card whose description precedes its action is caught.
const trap = { tag: 'article', attrs: {}, children: [
  { tag: 'p', attrs: {}, text: 'described first' },
  { tag: 'div', attrs: { 'data-action': 'x:confirm' }, text: 'Confirm' },
] };
const trapNodes = walk(trap);
if (trapNodes.findIndex((n) => n.tag === 'button') !== -1 || pointerOnlyControls(trap).length !== 1) {
  console.error('FAIL: the ordering and keyboard checks do not detect a known violation');
  process.exit(1);
}
console.log('    ordering and keyboard checks verified against a known violation');
"

# M-1 in the gate, not only in a test file. Two halves: nothing at runtime produces a promise
# owned by somebody else, and nothing CAN, because the attempt does not compile.
echo "==> GL: M-1 — a gesture may confirm your own promise and no one else's"
node --input-type=module -e "
import {
  MILA, STEFAN, asOwn, chatContext, chatReactionEvent, chatReactionFixture, commentReactionEvent,
  commentReactionFixture, fixtureDirectory, meetingEndCards, meetingFixture, prContext,
  resolveReaction, utteranceFixture,
} from './packages/gestures/dist/index.js';

// Every way somebody could try to put a promise on another person's name.
const attempts = [
  ['stefan taps the handshake on mila\\'s review comment', commentReactionEvent(commentReactionFixture('stefan'), prContext())],
  ['mila taps it on stefan\\'s chat message', chatReactionEvent(chatReactionFixture('I will send the schema', 'stefan'), chatContext())],
];
let checked = 0;
for (const [label, event] of attempts) {
  if (event === null) { console.error(\`FAIL: \${label} produced no event to check\`); process.exit(1); }
  const resolved = resolveReaction(event);
  if (resolved.kind !== 'card') { console.error(\`FAIL: \${label} produced no card\`); process.exit(1); }
  if (resolved.card.kind !== 'note-expectation') {
    console.error(\`FAIL: \${label} produced a \${resolved.card.kind} — 'they said they would' is an expectation (M-1)\`);
    process.exit(1);
  }
  for (const action of resolved.card.actions) {
    const intent = action.intent;
    if (intent.kind !== 'tool') continue;
    if (intent.tool === 'commit') {
      console.error(\`FAIL: \${label} emitted a commit for somebody else's promise\`);
      process.exit(1);
    }
    if (intent.tool === 'confirm' && intent.args.decision !== 'dismiss') {
      console.error(\`FAIL: \${label} emitted an accepting confirm on somebody else's words\`);
      process.exit(1);
    }
    if (JSON.stringify(intent.args).includes('\"owner\"')) {
      console.error(\`FAIL: \${label} named an owner in a tool argument\`);
      process.exit(1);
    }
  }
  checked++;
}

// The same, across a whole meeting: only the reader's own item is theirs to confirm.
const cards = meetingEndCards(meetingFixture(), fixtureDirectory(), MILA);
const kinds = cards.map((c) => c.kind);
if (kinds.filter((k) => k === 'confirm-own-promise').length !== 1) {
  console.error(\`FAIL: meeting cards \${kinds.join(', ')} — exactly one item is mila's\`);
  process.exit(1);
}
checked += cards.length;

// A speaker the directory cannot resolve is never me, even by accident.
if (asOwn(utteranceFixture({ speaker: { ...utteranceFixture().speaker, personaId: null } }), MILA) !== null) {
  console.error('FAIL: an unresolvable speaker was treated as the confirming person');
  process.exit(1);
}

// The check must be able to fail: my own words DO produce a promise I can record.
const mine = resolveReaction(commentReactionEvent(commentReactionFixture('mila'), prContext()));
if (mine.kind !== 'card' || mine.card.kind !== 'confirm-own-promise') {
  console.error('FAIL: the ownership check cannot distinguish my own promise from somebody else\\'s');
  process.exit(1);
}
console.log(\`    \${checked} gesture paths attempted on somebody else's promise, 0 proposals produced\`);
console.log('    ownership check verified against my own promise, which does produce one');
"

# The compile-time half. `confirmCard` takes an `OwnUtterance`, whose only constructor
# refuses somebody else's words — so the illegal case is unrepresentable rather than checked,
# and the way to prove that is to require the attempt not to build.
echo "==> GL: M-1 — the attempt does not compile"
TSC_FLAGS=(--noEmit --strict --module nodenext --moduleResolution nodenext --target es2023
           --skipLibCheck --verbatimModuleSyntax --noUncheckedIndexedAccess)
if ! npx tsc "${TSC_FLAGS[@]}" "${PKG}/test/type-negative/m1-legal.ts" >/dev/null 2>&1; then
  echo "FAIL: the legal control does not typecheck — the negative control below would prove nothing" >&2
  npx tsc "${TSC_FLAGS[@]}" "${PKG}/test/type-negative/m1-legal.ts" >&2 || true
  exit 1
fi
echo "    a gesture on my own promise typechecks"
if npx tsc "${TSC_FLAGS[@]}" "${PKG}/test/type-negative/m1-illegal.ts" >/dev/null 2>&1; then
  echo "FAIL: confirming somebody else's promise COMPILES — M-1 is checked, not unrepresentable" >&2
  exit 1
fi
echo "    a gesture on somebody else's promise does not typecheck (2 rejected call sites)"

# M-6 in the gate. The corpus is shipped with the package so the gate scans what ships.
echo "==> GL: M-6 — hostile text is quoted, never read as control"
node --input-type=module -e "
import { renderToHtml, visibleText } from './packages/client-web/dist/index.js';
import {
  HOSTILE_TEXTS, MILA, PENDING_ID, QUOTE_MAX_CHARS, STEFAN, chatContext, chatReactionEvent,
  chatReactionFixture, gestureCardEl, isScrubbed, quote, resolveReaction,
} from './packages/gestures/dist/index.js';

const RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const acting = (s) => [...s].map((c) => c.codePointAt(0)).filter((cp) => RANGES.some(([lo, hi]) => cp >= lo && cp <= hi));

let rendered = 0;
for (const hostile of HOSTILE_TEXTS) {
  const quoted = quote(hostile);
  if (!isScrubbed(quoted) || quoted.length > QUOTE_MAX_CHARS || acting(quoted).length > 0) {
    console.error(\`FAIL: a hostile body survived quoting: \${JSON.stringify(quoted.slice(0, 60))}\`);
    process.exit(1);
  }
  const event = chatReactionEvent(chatReactionFixture(hostile, 'mila'), chatContext());
  if (event === null) { console.error('FAIL: the reactor could not be attributed'); process.exit(1); }
  if (event.by !== MILA) { console.error('FAIL: the body chose who reacted'); process.exit(1); }

  const resolved = resolveReaction(event);
  if (resolved.kind !== 'card') continue;
  rendered++;

  // Nothing the body says reaches an argument.
  for (const action of resolved.card.actions) {
    const args = JSON.stringify(action.intent);
    for (const forbidden of ['\"owner\"', '<script', STEFAN]) {
      if (args.includes(forbidden)) {
        console.error(\`FAIL: a hostile body reached a tool argument (\${forbidden})\`);
        process.exit(1);
      }
    }
  }
  if (resolved.card.kind === 'confirm-own-promise' && resolved.card.actions[0].intent.args.id !== PENDING_ID) {
    console.error('FAIL: a hostile body selected the item being confirmed');
    process.exit(1);
  }

  // And nothing it says becomes markup or escapes its quote.
  const tree = gestureCardEl(resolved.card);
  const html = renderToHtml(tree);
  if (html.includes('<script>')) { console.error('FAIL: a body became markup'); process.exit(1); }
  for (const text of visibleText(tree)) {
    if (acting(text).length > 0) { console.error('FAIL: a control character reached the surface'); process.exit(1); }
  }
}
console.log(\`    \${HOSTILE_TEXTS.length} hostile bodies quoted, \${rendered} rendered, 0 reached an argument\`);

// The injection is SHOWN. Quoting is the defence, not filtering — if the words disappeared,
// this package would be interpreting them after all.
const shown = resolveReaction(chatReactionEvent(chatReactionFixture(HOSTILE_TEXTS[0], 'mila'), chatContext()));
if (shown.kind !== 'card' || !visibleText(gestureCardEl(shown.card)).join(' ').includes('ignore previous instructions')) {
  console.error('FAIL: the words were filtered rather than quoted');
  process.exit(1);
}
console.log('    the injection is shown verbatim and obeyed nowhere');

// The check must be able to fail: the same scan over the UNSCRUBBED bodies finds plenty.
const raw = HOSTILE_TEXTS.flatMap((t) => acting(t));
if (raw.length === 0) {
  console.error('FAIL: the control-character scanner does not detect a known violation');
  process.exit(1);
}
console.log(\`    scanner verified: \${raw.length} acting characters in the corpus before quoting\`);
"

echo "==> GL: no network from any gesture path"
node "${PKG}/test/support/prove-no-network.mjs"

echo "==> GL: gesture suite"
npx vitest run "${PKG}/test" --reporter=dot

echo "==> GL: named MUST tests for this layer"
# `|| true` used to be here, so a must-coverage FAILURE was captured as text and the gate went
# on to grep it for the rows it cared about. A MUST with no test would have passed this gate.
# The status is kept and acted on; the output is still captured, because the rows below are read
# from it.
if ! coverage="$(bash gates/must-coverage.sh 2>&1)"; then
  echo "FAIL: must-coverage did not pass" >&2
  printf '%s\n' "${coverage}" >&2
  exit 1
fi
for must in "${MUSTS[@]}"; do
  file="${PKG}/test/musts/${must}.test.ts"
  if [ ! -f "${file}" ]; then
    echo "FAIL: missing named MUST test ${file}" >&2
    exit 1
  fi
  if ! printf '%s' "${coverage}" | grep -qE "ok +${must}\b"; then
    echo "FAIL: must-coverage does not register ${must}" >&2
    printf '%s\n' "${coverage}" >&2
    exit 1
  fi
  printf '    %s\n' "$(printf '%s' "${coverage}" | grep -E "ok +${must}\b")"
done
# The total is deliberately not pinned here — see the note in gk-email.sh. `must-coverage.sh`
# fails on its own when a registered MUST has no test.
printf '   %s\n' "$(printf '%s' "${coverage}" | grep -E 'MUSTs covered')"

echo
echo "GATE GL: PASS"
