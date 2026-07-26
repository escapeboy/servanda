# @servanda/connectors-claude-code

Claude Code sessions → §2 signal envelopes.

Session transcripts are the input nobody else watches. Everyone watches GitHub; nobody watches what
you *told your agent* — and that is where spoken commitments actually live: *"leave the retry logic
as is, I'll add tests once the release ships."*

## Two ways in

```ts
const connector = new ClaudeCodeConnector({ persona });

connector.fromTranscript(lines);   // read existing ~/.claude/projects/**/*.jsonl
connector.fromHook(event);         // live session hook
```

Hook events map to `session_utterance`, `session_start`, `session_end`, `session_turn_end`.

## The hook writes nothing to stdout

`bin/servanda-cc-hook.mjs` appends NDJSON to `$SERVANDA_ENVELOPE_LOG` and prints **nothing**.

A Claude Code hook's stdout re-enters the model's context. A capture hook that spoke on stdout would
feed captured signal straight back to the model as text it reads — turning observation into
instruction and inverting M-6 at the very first hop. The quiet is the safety property.

## Defensive parsing

The transcript format is treated as untrusted and versionless: malformed lines are skipped, never
thrown on. A single corrupt line in a 200k-line corpus must not take down a capture run.

`tool_use` and `thinking` blocks produce no envelopes — machine traffic and private reasoning are
not utterances, and a promise is something a person said.

## Determinism

Same transcript in, byte-identical envelope set out. `occurred_at` comes from the source event, and
`received_at` is injectable, so no clock reads sit in the envelope path. Hook events, which carry no
timestamp of their own, take one from the caller for the same reason.

## Persona binding (M-5)

The persona is a **construction-time** parameter, not a per-call argument. §2 binds a connector
instance to exactly one persona at registration, and envelopes of different org personas must never
meet in one pipeline. Making it structural means the mixing bug cannot be written by accident.
