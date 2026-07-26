# @servanda/brief-email

The brief as a push projection — morning email, notification, glanceable summary.

```ts
renderBriefEmail(brief);   // → { subject, text, html }
```

**Identical content to the in-app Brief.** One renderer contract, not a second implementation: a
brief that says something different in email than in the app is two products disagreeing about what
you owe.

Same register as every other surface — notary, not coach. No exclamation marks, no guilt mechanics,
states not judgments. Human vocabulary only; gate GE greps this package's strings together with the
web and terminal clients.

Plain-text and HTML are both first-class. The text part is not a degraded fallback: a brief must be
readable in a terminal mail client, on a watch, and on a lock screen, because the whole point is
that it is glanceable.
