# Using Servanda

Everything below was run against this repository. No invented commands.

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm -r run build
```

---

## 1. Create a vault

The vault is yours. It is a git repository on your disk, encrypted with a content key that is
wrapped both by your passphrase and by any device key you add.

```bash
export SERVANDA_VAULT=~/.servanda
export SERVANDA_PASSPHRASE='something only you know'

node packages/node/dist/bin/servanda-init.js
```

```
Vault created at /Users/you/.servanda
Persona   08d0656dbea2fce9187f24fa73156ceb7189cbc5b75fb1e7c249248c69b125e8
Path      m/7391'/0'
Label     personal

─────────────────────────────────────────────────────────────────────
RECOVERY PHRASE — write it down now. It is shown once and stored nowhere.
─────────────────────────────────────────────────────────────────────
  color brand faith lady believe lounge
  ...
```

**Write the phrase down.** It is printed once and the program keeps no copy — a copy it kept would
be a copy an attacker could take. Those 24 words, an org re-attestation, or an external binding
proof are the only ways back (ADR-0014); a persona with none of them is unrecoverable by design.

The passphrase is not optional. **M-16**: a device key must never be the sole custodian of the
content key, so losing a laptop must not lose the vault.

Restoring on another machine is the same command with the phrase supplied — same phrase, same keys:

```bash
SERVANDA_MNEMONIC='color brand faith …' node packages/node/dist/bin/servanda-init.js
```

Other personas from the same seed (they are unlinkable to anyone without the seed, §1.2):

```bash
SERVANDA_INDEX=1 SERVANDA_LABEL=work node packages/node/dist/bin/servanda-init.js
```

---

## 2. Run the node

The node speaks MCP over stdio and exposes the six tools of §7 — `commit`, `expect`, `confirm`,
`open_loops`, `brief`, `act`. Configuration comes from the environment because stdio is the
protocol channel and must carry nothing else.

```bash
node packages/node/dist/bin/servanda-node.js
```

**It needs no network, no server and no second participant** (M-10). Solo use is complete use.

### Connect it to Claude Code

```bash
claude mcp add servanda -- node /path/to/servanda/packages/node/dist/bin/servanda-node.js \
  --env SERVANDA_VAULT=$HOME/.servanda \
  --env SERVANDA_PASSPHRASE='something only you know'
```

Then talk to your assistant normally. *"I told Maria I'd send the quote by Friday"* reaches
`commit`; *"what do I owe?"* reaches `open_loops`. Your assistant is a client — Servanda never
ships a chat UI, because assistants are clients permanently.

---

## 3. Capture what you say

You do not type promises into Servanda. It observes.

### Claude Code sessions

The unique input nobody else watches: everyone watches your repository, nobody watches what you
*told your agent*. Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
                    "command": "SERVANDA_ENVELOPE_LOG=$HOME/.servanda/envelopes.ndjson node /path/to/servanda/packages/connectors-claude-code/bin/servanda-cc-hook.mjs" }] }
    ]
  }
}
```

The hook writes NDJSON and prints **nothing**. A hook's stdout re-enters the model's context, so a
chatty capture hook would feed observations back as instructions and invert M-6 at the first hop.

### A repository you already have

Archaeology needs no configuration and no network — it mines a local clone for promises already
lying in it: TODOs with blame age, dormant branches, dead feature flags, unrun migrations.

```ts
import { GithubConnector } from '@servanda/connectors-github';
import { archaeologyCandidates } from '@servanda/node';

const envelopes = new GithubConnector({ persona }).archaeology({
  repoPath: '/path/to/repo',
  receivedAt: new Date().toISOString(),
  referenceTime: new Date().toISOString(),
});
const candidates = archaeologyCandidates(envelopes, { persona, createdAt: … });
```

This is the cold start: an hour after connecting a repository you have a brief, without having
spoken a single promise.

### Mail

The path for everyone who does not live in a terminal. `@servanda/connectors-email` captures IMAP,
mines *sent* mail for promises made and answers awaited, and treats a BCC or forward as capture
without a screen. The IMAP client is an injected interface, so it can be pointed at a fixture as
easily as at a server.

---

## 4. Read your register

### Terminal

```bash
SERVANDA_VAULT=~/.servanda SERVANDA_PASSPHRASE='…' node packages/tui/bin/servanda.mjs
SERVANDA_VAULT=~/.servanda SERVANDA_PASSPHRASE='…' node packages/tui/bin/servanda.mjs --ink
```

Views: **Today · You owe · You are waiting · Closed · To confirm · Standup · Sources and trust.**
Full keyboard operation; Tab reaches the leading action of every card first.

Run it with **no** environment and you get a **demonstration** on invented promises, labelled as
one in a line above the frame. That mode exists because the surfaces were built before anything
could serve them real data, and it is still the right thing to show someone with no vault yet —
but a sample must never be mistakable for a register, so it says which it is, every time.

`SERVANDA_VAULT` set without `SERVANDA_PASSPHRASE` is an error, not a fallback. Showing a sample
where somebody expected their own promises is worse than refusing.

`SERVANDA_PERSONA` selects one by `persona_id` or by its local label; omitted, you get the first.

**To confirm** was empty against a real vault for a while, and the reason was worth stating: §7's
`confirm` takes an id and no tool handed one out, so a client could write to the queue and never
read it. `open_loops` now takes `view: 'pending'` and answers with the waiting extractions, ids
included, so the queue is reachable from outside the node.

### Email brief

`@servanda/brief-email` renders the same brief as text and HTML. Identical content to the in-app
brief by construction — the HTML *is* the app's own element tree serialised, so the two cannot
disagree about what you owe.

---

## 5. Work with someone else

Everything above is solo. A promise becomes *bilateral* when the other party signs it (**M-2**).

`@servanda/federation` carries proposals and assertions between nodes over a shared git repository
or an HTTPS hub. A hub is a blind courier: it sees a recipient, ciphertext and a timestamp, and
nothing else — not the sender, not the promise.

Reconciliation never decides anything. Assertions arriving over the wire go through the same
transition table as local ones, so an invalid one is discarded exactly as it would be at home
(M-14).

---

## 6. Let it do the work

Executors turn an aging promise into **finished work awaiting approval** rather than a reminder. A
reminder costs attention; a ready draft PR costs one review.

Three classes only — `tests`, `dead-code`, `dep-bump` — and the output is always a draft:

```ts
import { runExecutor } from '@servanda/executors';
const outcome = await runExecutor({ executorClass: 'tests', commitment, target, persona, repo });
```

The sandbox has no network and no environment: CI secrets are absent from the executor's world and
from its artefact. The artefact is **unsigned** — automation acts under a persona, never as one
(M-13), so a human signature is the only thing that can make it real.

Autonomy is earned, never configured: `draft-for-review → auto-apply-with-window →
silent-with-receipt`, derived per (human, work class) from your own approvals. Collapse is
asymmetric — one correction drops a class to the floor and five approvals do not undo it — and
ceilinged classes never reach silent no matter how good the record.

---

## 7. Check what extraction actually finds

```bash
pnpm --filter @servanda/extraction harness --dry-run   # stub, no API calls, no spend
ANTHROPIC_API_KEY=… pnpm --filter @servanda/extraction harness
node packages/extraction/scripts/precision-via-claude-cli.mjs   # local claude CLI, no key
```

Writes `precision-report.md`: every extracted commitment with its verbatim source quote, file, line
and envelope hash, so you can judge each one. **The report scores nothing** — precision is a human
verdict and the harness says so at the top.

Nothing it finds is committed anywhere. It is read-only with respect to protocol state.

`--max-utterance-chars` clips long utterances to save tokens. It is **off by default** and the
price is measured: at 1000 characters it cuts 40% of utterances, six of them lose their only
promise language, and a full pass drops from 34 findings to 22. Cost is a choice; recall is not.

---

## 8. Verify the whole thing

```bash
pnpm test         # full suite
pnpm gates        # every gate, in order
```

A stage is done only when its gate passes, and `gates/must-coverage.sh` separately proves every one
of M-1..M-16 has a named test. A MUST with no test is a rule nothing enforces.
