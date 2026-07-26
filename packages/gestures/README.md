# @servanda/gestures

In-situ capture and confirmation — surface 3 of the doctrine's seven, and the last one to exist.

> "Capture and confirmation have no screens of their own by definition: they are in-situ gestures
> (🤝 reaction, BCC/forward, a word to any assistant, session hooks)." — `ui-design.md`

A promise is confirmed **where it was spoken**, in one tap. Visiting an app to confirm a sentence
you already wrote is the failure this surface exists to prevent.

## The card

One typed object answering the three questions every card must answer — **what · with whom · what
happens if I do nothing** — with the primary action leading, so the first thing Tab reaches and the
first thing a screen reader announces is the thing you probably want.

Confirm and dismiss are **both flywheel labels** (ADR-0012). A dismissal is data, not a discarded
event: it is exactly what makes the next wrong extraction less likely.

## M-1, enforced by the compiler

A gesture may confirm **your own** promise. It may never let one person assert another's — "they
said they would" is an expectation, never a proposal on their behalf.

That is not a runtime check here. The attempt **does not compile**.

## The two-taps problem, answered rather than claimed away

`scenarios.md` names it honestly: confirm-first costs two taps from two people for one sentence in a
review comment.

The second tap cannot be removed. The counterparty's signature is what makes the promise bilateral
(M-2); a design that dropped it would be faster and would no longer be Servanda.

What changes is its **character**:

- the promiser taps in place, in the window they are already in, and their half is recorded at once;
- the other party is never gestured at — their half arrives batched in their next brief, and
  interrupts nothing.

Two interrupting taps become one in-place tap and one batched line. `whenTheOtherHalfArrives()`
states that in the type system rather than in a comment.

## Adapters

Thin, injected shims over platform payloads (chat webhook, PR comment). Modelled locally; no
network from any gesture path, and the gate proves it. The intents a gesture emits are exactly the
§7 tools — where §7 offers no tool for an action (upstream issue #19), a typed `unmapped` intent is
emitted rather than a tool name invented.
