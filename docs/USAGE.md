# Using Servanda

Everything below was run, not imagined. No invented commands.

**Two ways in, and they are not interchangeable.** `servanda` is on npm, so §2 works from an
install. Everything else here — the node, capture, the harness, the gates — is run from a
checkout, because those packages either are not published (`@servanda/ingest`) or are libraries
rather than commands.

```bash
npm install -g @servanda/tui        # for §2

git clone https://github.com/escapeboy/servanda && cd servanda
pnpm install && pnpm -r run build   # for everything else
```

Requires Node 22+ and pnpm 10.

---

## 1. Create a vault

The vault is yours. It is a git repository on your disk, encrypted with a content key that is
wrapped both by your passphrase and by any device key you add.

```bash
export SERVANDA_VAULT=~/.servanda
export SERVANDA_PASSPHRASE='something only you know'

node packages/node/dist/bin/servanda-init.js
```

It sits there for several seconds first and says so on stderr: the passphrase wrap is Argon2id at
the §9.3 desktop point (m = 1 GiB), and that cost is the property, not a delay to tune away. Every
later open pays it again.

```
Deriving the vault key (Argon2id — seconds, and about a gigabyte of memory)…

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

**The phrase restores your keys. It does not restore your register — back up the directory.**
This page puts "restoring on another machine" four lines above "losing a laptop must not lose the
vault", and they read as one promise. They are two, and the phrase keeps only the first. What the
seed rebuilds is your *identity*: same words, same persona id, same private key, on any machine.
What it cannot rebuild is what you promised, because that lives in the vault's own git repository
and nowhere else. Restore from the phrase alone and you get a correct persona and an empty
register.

So copy `$SERVANDA_VAULT` somewhere. It is a git repository — clone it, push it to a remote you
control, put it in a backup. For **bilateral** edges there is a second route, §6.6 recovery from
the counterparty, which serves edges and assertion chains but no plaintext; solo commitments,
which M-10 says are complete use, are recoverable from a copy of the directory and from nothing
else.

Give the phrase back in whatever shape you wrote it down: line breaks, capitals and stray spaces
are normalised away before it is checked. What is *not* forgiven is a missing word or a wrong one,
and the refusal says which of those it was — a phrase rejected for its formatting, when this page
has just told you those 24 words are the only way back, reads as a lost vault.

Other personas from the same seed (they are unlinkable to anyone without the seed, §1.2). Run it
against the vault you already have, and supply the phrase — the vault stores persona keys, not the
seed they came from, so it cannot derive a sibling on its own:

```bash
SERVANDA_MNEMONIC='color brand faith …' SERVANDA_INDEX=1 SERVANDA_LABEL=work \
  node packages/node/dist/bin/servanda-init.js
```

The label has to be unique within the vault, because a label is one of the two ways to name a
persona later (§1.2). An index the vault already holds is refused rather than re-derived, and so is
a phrase that is valid but is not the one this vault's personas came from: one vault holding two
seeds is a vault no single phrase restores.

### If your vault was made by an older build

Every published version through `0.4.0-pre` made vaults at the §9.3 **floor** (m = 64 MiB) rather
than the desktop point above. A wrap is opened at the profile it was written at, so such a vault
stays there for its whole life: it opens normally and nothing about it has leaked, but somebody who
copies the directory and guesses passphrases against it needs about sixteen times less memory per
guess than against a vault made today. The tools say so themselves, on stderr, whenever they open
one.

```bash
SERVANDA_VAULT=~/.servanda SERVANDA_PASSPHRASE='…' SERVANDA_UPGRADE_KEY=1 \
  node packages/node/dist/bin/servanda-init.js
```

About a minute of one core. Same passphrase, same recovery phrase, same personas, same promises —
the content key does not change, so every device wrap still opens too. Running it on a vault that
is already current says so and does nothing.

---

## 2. Record a promise

```bash
npm install -g @servanda/tui
servanda commit "Send Maria the warehouse quote" --due 2026-08-11
servanda
```

That is the whole of it. No assistant, no API key, no network — which is §0's base rule
(**M-10**) made usable rather than merely true. Until v0.5.2-pre nothing shipped could put a
promise into a register: `commit` was reachable through MCP or through §3 extraction and by no
other door.

```bash
servanda commit "<what you promised>" [--to <who>] [--due <date>] [--propose]
servanda expect "<what you are waiting for>" --to <who>
servanda done <id> --evidence "<what you delivered>"
servanda release <id>
servanda sync
servanda                                  # the register
```

**`--propose` is what sends it.** Without it the promise stays on this machine, and that is the
default rather than the fallback.

**`--to` takes a persona id, not a label.** A local label names *who you are acting as* (§1.2),
never who a promise is owed to — `owed_to` on the wire is a persona id or a §3.1 `external_label`.
If the two were merged, typing `--to Boyan` for an off-network Boyan, in a vault that happens to
hold a persona labelled `Boyan`, would silently redirect the promise to yourself *and put it on
the wire*. One typed word, two outcomes, and the dangerous one is the quiet one. When the name
matches one of your own personas the command says so and hands you the id.

**`done` requires `--evidence`; `release` refuses it.** §4.3: a closure by the owner carries the
hash of what was delivered — that is what separates it from an assertion. Giving up a claim is not
evidencing delivery. Only the hash is recorded; the words stay on this machine (**M-7**).

### Sending and collecting

```bash
export SERVANDA_GIT_REMOTE=/path/to/shared.git    # or a URL
export SERVANDA_GIT_CLONE=~/.servanda-courier     # NOT inside your vault
servanda sync
```

Both people point at the same repository. Nothing in it is readable by anyone but the recipient —
§6.3: a courier carries sealed envelopes and cannot open them.

`sync` runs **once and exits**. §6.7 lets a courier lose, duplicate and reorder, and the answer to
all three is to ask again — which is a thing a person does when they want to, not a process that
reads their register on a timer. Put it in `cron` or `launchd` if you decide you want that.

The clone must not be inside the vault: the vault commits everything in its tree, so a courier
writing there would put wire traffic into the record it exists to carry. The command refuses
rather than choosing a directory for you.

**One transport at a time.** §6.1's per-recipient routing is what lets a node hold several
couriers, and this does not expose it — so a person on a shared repository and a person on a hub
cannot yet reach each other. Said here rather than left to be discovered as silence.

### What the other person sees

Their register shows the promise with **Confirm** and **Not a promise** — and *not* its words:

    (the words stayed with the person who wrote them)

That is **M-7**, not a defect. Plaintext never crosses the wire. The promise was made in a
conversation you both remember; Servanda records *that* it was made and binds it to a hash, so
neither of you can later say it was something else. It does not transmit it.

---

## 3. Run the node

The node speaks MCP over stdio and exposes the six tools of §7 — `commit`, `expect`, `confirm`,
`open_loops`, `brief`, `act`. Configuration comes from the environment because stdio is the
protocol channel and must carry nothing else.

```bash
node packages/node/dist/bin/servanda-node.js
```

**It needs no network, no server and no second participant** (M-10). Solo use is complete use.

### Connect it to Claude Code

```bash
claude mcp add servanda \
  -e SERVANDA_VAULT=$HOME/.servanda \
  -e SERVANDA_PASSPHRASE='something only you know' \
  -- node /path/to/servanda/packages/node/dist/bin/servanda-node.js
```

`-e` before the `--`, and the command after it. Everything following `--` is the subprocess's own
argv: environment written there is handed to `node` as arguments it ignores, the node starts with
no vault, and what you see is a server that failed to connect for no stated reason. Check with
`claude mcp list`.

Registering it this way writes the passphrase in cleartext into the client's config, and the shell
line into your history. That is the price of a node a client can start unattended; §1 keeps the
passphrase out of `ps` and history when *you* are the one starting it.

Then talk to your assistant normally. *"I told Maria I'd send the quote by Friday"* reaches
`commit`; *"what do I owe?"* reaches `open_loops`. Your assistant is a client — Servanda never
ships a chat UI, because assistants are clients permanently.

---

## 4. Capture what you say

You do not type promises into Servanda. It observes.

### Claude Code sessions

The unique input nobody else watches: everyone watches your repository, nobody watches what you
*told your agent*.

**Be clear about what this does today.** The hook captures utterances into an NDJSON log.
`servanda-ingest` reads that log, extracts §3.1 candidates from it, and puts them in the
confirmation queue — so `open_loops({view: "pending"})` shows them, the register's **To confirm**
screen lists them, and `confirm` acts on them.

```bash
SERVANDA_VAULT=~/.servanda SERVANDA_PASSPHRASE=… servanda-ingest
```

It runs once and exits: it reads the log to the end, queues what it found, records how far it
got, and tells you which of those happened. Run it when you want to, or from `cron` or `launchd`
if you decide you want that.

**One shot rather than a daemon, deliberately.** A process that watches the log continuously is a
standing capture posture — everything you type at an agent, read and sent to a model, without
anyone being asked again. A command you invoke leaves that decision yours, and leaves it visible.

Reading a promise out of what you wrote is a model call, and by default it uses the `claude`
command you are already signed in to — no API key, no cost. Set `ANTHROPIC_API_KEY` to use the
API instead. **The command says which one read your words**, because the two are not equally
tool-less and §3.4 / M-6 asks for the stronger property:

- **the API** is tool-less *structurally* — the request has no field a tool could be named in, so
  there is nothing to disable and nothing to get wrong. This is the path a conformance claim
  rests on.
- **the CLI** is tool-less *configurationally, then verified*. It is an agent and inherits your
  environment. That was measured rather than assumed: with built-in tools disallowed but MCP left
  alone, the model was handed `serena.read_file` and attempted it, responding to an instruction
  embedded in its input. Only the permission layer stopped it. So the backend strips MCP,
  disallows every built-in, and checks the outcome — a run that touched a tool is failed rather
  than returned.

"Tools that are blocked" is weaker than "no tools". Fine for reading your own register; not what
a conformance claim rests on.

**A session Servanda spawns is not captured.** The CLI backend starts `claude`, and a spawned
session fires your own `UserPromptSubmit` hooks — so without a guard the connector writes the
*extraction prompt* into the log as a new utterance, and the next run extracts from its own
output. The spawned process carries `SERVANDA_CAPTURE=off` and the hook exits before reading
stdin when it sees it. Found within a minute of the hook being switched on for the first time, on
a log holding one real utterance.

This paragraph said the opposite until the queue and the reader were connected, and the reason
it could say so honestly for months is worth keeping: the hook wrote, the harness read
`~/.claude/projects/**/*.jsonl` directly, and the envelope log sat between them touched by
nothing. A document describing a capability that does not exist is how an audit found four false
claims in the release criteria.

**Where an unconfirmed candidate lives, and why it is not in the vault.** The queue is in
`$SERVANDA_STATE_DIR` (default `~/.servanda-state`), sealed with the vault's content key but
outside its git repository. The vault is a git repository — that is what makes §4.2's chains
append-only and sound — so anything written there is written for ever: deleting a queued
candidate removed it from the working tree while the sealed blob stayed in history under the same
key. An unconfirmed candidate is a guess about what you meant, made by a model, that you have not
agreed to. It does not earn permanence, and it is genuinely deletable here.

Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
                    "command": "SERVANDA_PERSONA=08d0656d… SERVANDA_ENVELOPE_LOG=$HOME/.servanda-envelopes.ndjson node /path/to/servanda/packages/connectors-claude-code/bin/servanda-cc-hook.mjs" }] }
    ]
  }
}
```

**Both variables are required, and both are set on the command line rather than exported.**
`SERVANDA_PERSONA` is the `persona_id` `servanda-init` printed — registration is where the persona
binding happens (§2 / M-5), and the hook has no other way to know whose utterance this is.

Here `SERVANDA_PERSONA` means **the 64-character `persona_id`, and nothing else.** This is the one
place in Servanda where that name does not also take a local label: §4's register and §2's node
resolve either, the hook resolves neither — it validates the value against `persona_id`'s shape and
stops. So `export SERVANDA_PERSONA=work` in your shell profile, which §4 invites and which works
everywhere else, leaves you with a working register, a working node, and a hook that captures
nothing from that moment on. Setting it inline in the `command`, as above, overrides whatever the
shell exported and is why the snippet is written this way — do not "simplify" it into your profile.

Get either variable wrong and the hook exits 0 having written nothing. Missing, it says nothing at
all; wrong-shaped, it prints a schema error that names neither the variable nor the fix — and hook
stderr only surfaces in the debug transcript, so in practice both look identical to *"I haven't
promised anything lately."* **Check `wc -l` on the log after your first prompt.** That one command
is the whole difference between capture and silence.

The log goes **outside** `$SERVANDA_VAULT`. It is cleartext, and the vault directory is a git
repository that commits everything in it: a log kept there would be swept into vault history in the
clear, on the next thing you record, permanently.

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
// `mine` is your git identity — name and email, both, because a dormant branch and an unrun
// migration record only a name. Findings by anyone else are not yours.
const { candidates, skipped } = archaeologyCandidates(envelopes, {
  persona,
  createdAt: new Date().toISOString(),
  mine: ['you@example.com', 'Your Name'],
});
```

**`mine` is required, and that is the point.** A commitment's owner is its giver (M-1), and this
turns findings into *your* commitments — so on a repository you share with other people, every
TODO they wrote would otherwise arrive as a promise you made. Measured on a scratch repo of 10 000
findings by one other author: 10 000 candidates, all stamped as yours, oldest first, uncapped.
`skipped` tells you what was left out and why, because a correct filter and a broken miner must
not look the same from the outside.

This is the cold start: an hour after connecting a repository you have a brief, without having
spoken a single promise.

### Mail

The path for everyone who does not live in a terminal. `@servanda/connectors-email` captures IMAP,
mines *sent* mail for promises made and answers awaited, and treats a BCC or forward as capture
without a screen. The IMAP client is an injected interface, so it can be pointed at a fixture as
easily as at a server.

---

## 5. Read your register

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
The node in §2 reads the same variable the same way, and refuses to start on a value that matches
neither — a persona settled at startup is a persona the assistant cannot discover halfway through.

**The capture hook in §3 does not.** It takes the `persona_id` only. One name, two contracts, and
the divergence is real rather than a documentation slip — so if you export this variable at all,
export the `persona_id`, which every consumer accepts. A label is safe only where you pass it to a
single command.

A wrong passphrase and a directory that is not a vault are different messages, and neither is a
stack trace. Under an MCP client you will not see them at all: the client reports a server that
failed to start, and the sentence is on the node's stderr.

**To confirm** was empty against a real vault for a while, and the reason was worth stating: §7's
`confirm` takes an id and no tool handed one out, so a client could write to the queue and never
read it. `open_loops` now takes `view: 'pending'` and answers with the waiting extractions, ids
included, so the queue is reachable from outside the node.

### Email brief

`@servanda/brief-email` renders the same brief as text and HTML. Identical content to the in-app
brief by construction — the HTML *is* the app's own element tree serialised, so the two cannot
disagree about what you owe.

---

## 6. Work with someone else

Everything above is solo. A promise becomes *bilateral* when the other party signs it (**M-2**).

`@servanda/federation` carries proposals and assertions between nodes over a shared git repository
or an HTTPS hub. A hub is a blind courier: it sees a recipient, ciphertext and a timestamp, and
nothing else — not the sender, not the promise.

Reconciliation never decides anything. Assertions arriving over the wire go through the same
transition table as local ones, so an invalid one is discarded exactly as it would be at home
(M-14).

---

## 7. Let it do the work

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

## 8. Check what extraction actually finds

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

## 9. Verify the whole thing

```bash
pnpm test         # full suite
pnpm gates        # every gate, in order
```

A stage is done only when its gate passes, and `gates/must-coverage.sh` separately proves that every
§8 MUST has a named test. A MUST with no test is a rule nothing enforces.
