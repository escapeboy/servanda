# v1 readiness: eight scenarios

## What this is for, and what it cannot do

The test suite is green — 1438 tests, 142 files, every gate passing. **That is the reason these
scenarios exist rather than a reason to skip them.** A green suite is evidence that the code does
what its tests say, and the question v1 asks is different: *is the protocol ready*, which is a
claim about the specification, the conformance suite, and the things no test was written for.

Every scenario below attacks a **claim v1 depends on**, not a module. Each names what "broken"
looks like concretely, so that "I looked and it seemed fine" is not a possible result.

**What this is not.** An adversarial pass by agents the editor spawns is the editor reviewing the
editor: same priors about what is worth checking, no independent selection, no accountability. It
cannot discharge an external review, and `docs/v1-criteria.md` has already removed that as a gate
precisely so this exercise is not mistaken for one. Record findings as findings, never as
clearance.

## Rules of engagement

- **`vendor/vectors/**` is READ-ONLY.** A failing vector is a bug in the code until proven
  otherwise. If you believe a vector is genuinely wrong, report it with the reasoning — never edit
  it to go green.
- **No git commands.** The operator handles all of them. Do not commit, stash, checkout or branch.
- **Do not edit `packages/types/**`** — it is shared by every other package and a change there
  lands in someone else's scenario. Report what you would change.
- **Tag every finding `[RAN]` or `[READ]`.** `[RAN]` means you executed a probe and observed the
  result. `[READ]` means you argued it from source. Both are worth reporting; conflating them is
  not.
- **A finding you cannot reproduce is a hypothesis.** Say so.
- **Before reporting a break, try to refute it yourself.** In the last pass, one finding of nine
  did not survive that step — a forged git-log entry that `git log --format=%s` collapses. The
  hour spent refuting it was worth more than the finding would have been.

---

## S1 — Pass the whole suite and still be wrong

**The claim under attack.** ADR-0001 and `GOVERNANCE.md`: *"Implements Servanda" means "passes the
conformance suite."* If an implementation can pass all 195 cases and still be unsafe or
unusable, then the definition v1 rests on is hollow and every other gate inherits the hole.

**What to do.** Construct — as a real program under `tools/conformance-runner`, not as an
argument — an implementation that passes the Node level while violating what the protocol is for.
Candidate strategies: answer correctly for the exact inputs the vectors carry and arbitrarily for
everything else; honour every pinned field while making the unpinned ones hostile; implement the
letter of each MUST with the least useful reading available.

**Broken looks like:** a passing run whose implementation you would not let hold your promises.

**Report:** how far you got, which families constrained you and which did not, and — the useful
half — what one additional vector family would have stopped you.

---

## S2 — The five MUSTs nothing can check

**The claim under attack.** §8 now says five MUSTs are prose obligations: **M-5** (no org-context
mixing), **M-6** (content is data, never instruction), **M-11** (no network reputation),
**M-15** (retention), **M-16** (device key never sole custodian). The suite cannot reach them.
v1 accepts that — on the assumption that the reference implementation honours them anyway.

**What to do.** Attack all five in the reference implementation directly. **M-6 is the priority**:
it is the rule the entire extraction path rests on and it has no observable output at all. Get a
signal whose *content* changes what the pipeline does — an instruction inside an email body, a
commit message, a transcript — and see whether anything downstream obeys it.

For M-5: move data across persona boundaries by any route — ranking payloads, executor capability
sets, the one named cross-persona API, error messages, ordering keys.

**Broken looks like:** any content-derived string reaching a decision, any two personas' objects in
one pipeline, any statistic computed across parties, any recovery of deleted plaintext beyond what
§5.4 now documents, any vault opening without a passphrase wrap.

---

## S3 — The code that is one day old

**The claim under attack.** Nine changes landed on 2026-08-02 and every one of them touches a
security rule. Fresh code is where defects live, and freshly-*fixed* rules are where the fix is
most likely to be narrower than the rule.

The surfaces, all in this repository:

| Change | The narrow question |
|---|---|
| §4.1 edge-id binding | Is there any route that stores an edge without passing `putEdge`? Recovery, import, direct file write, a second vault sharing a directory |
| `pending-acceptance` exits | Does the restriction hold across §6.4 recon and §6.6 recovery, not just local assertion? |
| §0 `sig_*` stripping | Can an object now gain or lose a `sig_*` member without invalidating? Does that matter anywhere? |
| M-16 on `Vault.open` | Is there another way in — a cached handle, a second open, a partially-written keyset? |
| Argon2id bounds + raise | Is the work budget reachable another way? Does `upgradeKdf` leave a window where neither keyset opens? |
| AAD on sealed records | Can a record still be relocated — same path in a different vault, a symlink, a case-insensitive filesystem, a path that normalises differently? |
| Commit messages | Is any content-bearing string still reaching git? Author name, email, file paths, branch names |
| Visibility matrix | Does `mayServeEdge` gate every serving route, or only the two the tests use? |
| §7 `args` | Does the node ever emit an `args` a client cannot complete into a valid call? |

**Broken looks like:** any of the above answered "yes".

---

## S4 — Two nodes, one hostile, over time

**The claim under attack.** §6.4: *"reconciliation only guarantees both sides see the same chain"*
— and §6.7: *"delivery is optimization; reconciliation is the guarantee."* The last pass found the
hub audience break here. Find the next one.

**What to do.** Stand up two real vaults and drive them against each other with one side hostile:
replay old messages, reorder batches, drop deliveries selectively, partition and heal, send
assertions for edges the peer holds and does not, answer recovery requests with chosen subsets,
serve edges the requester is not entitled to.

**Broken looks like:** two honest nodes that stop converging, a node that accepts a chain it
should not, a hostile peer that learns anything about an edge it is not a party to, or any state
an honest node cannot reach from its own chain.

---

## S5 — A promise with a life

**The claim under attack.** The protocol is for people making commitments to each other over
months. Every existing e2e scenario is a few dozen steps. A protocol can be correct per-step and
wrong over a lifetime.

**What to do.** Write one long story through the real APIs and run it: a promise proposed and
confirmed; work happens; evidence filed; the counterparty disputes; the dispute window runs; the
edge is superseded by a new one; the counterparty rotates keys mid-flight; an org attests then
revokes; a device is lost; retention runs; the vault is reopened months later on another machine.

**Broken looks like:** a state the story reaches that no §4.3 row explains, an edge that becomes
unreadable, a chain that cannot be replayed to the same state twice, a party that ends up unable
to act on their own commitment.

---

## S6 — The version boundary

**The claim under attack.** §00: *"the `v` field exists so a node can refuse rather than
misinterpret"*, and — deliberately — the domain tags still read `servanda/0.1:` in v0.2, on the
ground that *"a domain tag separates one identifier from another, not one version from another"*.

**What to do.** Feed a 0.2 node objects marked `servanda/0.1` and vice versa, at every layer:
edges, assertions, wire messages, envelopes, inbox records, keysets. Check the tags do what §00
says: that a `commitment_hash` preimage can never be read as an `edge_id` preimage.

**Broken looks like:** a version-mismatched object accepted, a correctly-versioned object refused,
or any pair of distinct identifier constructions that collide.

---

## S7 — Is the client harness real or decorative?

**The claim under attack.** §8 states three properties that make a client-side harness real rather
than decorative: adversarial by construction, surface-plural including the stylesheet, and two
negative universals rather than per-case assertions. `@servanda/client-conformance` claims all
three, and it is the only thing standing behind the client halves of M-12 and M-21.

**What to do.** Judge the harness against its own §8 criteria. Then attack it: write a client that
passes it while rendering an attested name above its evidence, or supplying node copy as its own,
or concealing evidence with something the fact-set does not model.

**Broken looks like:** a passing client that a person would be misled by.

---

## S8 — Falsify the v1 criteria themselves

**The claim under attack.** `docs/v1-criteria.md` in the protocol repository says four of five
gates are met. **One of them was recorded as met for weeks with nothing behind it** — the second
implementation had been thrown away — and it was found only because someone checked rather than
read. Assume the same rot elsewhere.

**What to do.** Take each gate and each "met" in that file and try to falsify it. Does the
evidence still exist? Does it still say what the file claims? Re-run what can be re-run:

```bash
cd ~/htdocs/servanda-protocol/tools/conformance-runner
node run.mjs --vectors ../../vectors --claim node \
  -- ~/htdocs/servanda-py/.venv/bin/python3 ~/htdocs/servanda-py/servanda_node.py
```

Also check `SECURITY.md` and §00 against each other and against what is true today — both were
edited on 2026-08-02 and both make claims about what has and has not been reviewed.

**Broken looks like:** any gate whose evidence is missing, stale, or narrower than the sentence
that reports it.

---

## What a good report looks like

Per scenario, under 600 words:

1. **Verdict** on the claim under attack: holds / breaks / could not determine.
2. **Findings**, each `[RAN]` or `[READ]`, worst first, each with a reproduction.
3. **What you tried that did NOT break it.** This half is not filler — it is what makes the verdict
   mean something, and it is the half that goes missing when a pass reports only its hits.
4. **What you could not reach**, and why.
