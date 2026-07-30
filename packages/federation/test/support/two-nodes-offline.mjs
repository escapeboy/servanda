#!/usr/bin/env node
/**
 * GATE GF, requirement 1: two nodes reach agreement over a transport with NO network.
 *
 * Two vaults, two working clones, one local bare repository. A proposes, B confirms, and the
 * confirmation travels back. Both sides must end on the same chain and the same effective
 * state. Run as a child of `prove-no-network.mjs` under `--require deny-network.cjs`, so any
 * network primitive touched anywhere in this path kills the process.
 *
 * Prints one JSON object on stdout and exits non-zero on any mismatch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { ServandaNode, effectiveState } from '@servanda/node';
import { Vault } from '@servanda/vault';
import { FederatedNode, GitTransport } from '../../dist/index.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const NOW = () => new Date('2026-07-25T09:00:00.000Z');

const root = mkdtempSync(join(tmpdir(), 'servanda-gf-'));
const seed = mnemonicToSeed(MNEMONIC);
const failures = [];

function check(ok, label, detail = '') {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  const shared = GitTransport.initShared(join(root, 'shared.git'));
  // The medium is a filesystem path: no scheme, no host, nothing resolvable.
  check(/^\//.test(shared) && !shared.includes('://'), 'the shared repository is a local path', shared);

  const peers = ['a', 'b'].map((label, index) => {
    const derived = derivePersona(seed, index);
    const dir = join(root, `${label}-vault`);
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, now: NOW });
    vault.putPersona({
      persona_id: derived.personaId,
      persona_index: index,
      label,
      scope_kind: 'personal',
      org_root: null,
      private_key: derived.privateKey,
      created_at: NOW().toISOString(),
    });
    const transport = GitTransport.init({
      dir: join(root, `${label}-clone`),
      persona: derived.personaId,
      remote: shared,
    });
    return {
      personaId: derived.personaId,
      vault,
      node: new ServandaNode({ vault, activePersona: derived.personaId, now: NOW }),
      fed: new FederatedNode({ vault, persona: derived.personaId, transport, now: NOW }),
    };
  });

  const [a, b] = peers;

  const commit = a.node.commit({
    intent: 'agree across two machines with no network',
    owed_to: b.personaId,
    due: null,
    persona: null,
    propose: true,
  });
  const edgeId = commit.edge_id;
  check(commit.state === 'proposed' && typeof edgeId === 'string', 'A produced a proposed edge');

  check((await a.fed.push()) > 0, 'A handed the propose message to the transport');
  const inbound = await b.fed.pull();
  check(
    inbound.accepted.some((x) => x.type === 'propose' && x.edge_id === edgeId),
    'B received and admitted the proposal',
    JSON.stringify(inbound.discarded),
  );

  // M-2 on the wire: holding the proposal is not having promised anything.
  const bEdge = b.vault.getEdge(b.personaId, edgeId);
  check(bEdge !== null, 'B holds the edge');
  check(
    effectiveState(bEdge, b.vault.getAssertions(b.personaId, edgeId)) === 'proposed',
    'B sees `proposed`, not `open`',
  );

  check(b.node.confirm({ id: edgeId, decision: 'confirm' }).state === 'confirmed', 'B confirmed');
  check((await b.fed.push()) > 0, 'B handed the confirmation to the transport');
  const back = await a.fed.pull();
  check(
    back.accepted.some((x) => x.type === 'assert' && x.edge_id === edgeId),
    'A received the confirmation',
    JSON.stringify(back.discarded),
  );

  const states = [];
  const chains = [];
  for (const peer of peers) {
    const edge = peer.vault.getEdge(peer.personaId, edgeId);
    const chain = peer.vault.getAssertions(peer.personaId, edgeId);
    states.push(effectiveState(edge, chain));
    chains.push(chain.map((x) => x.sig).join('|'));
  }
  check(states[0] === 'open' && states[1] === 'open', 'both nodes converged on `open`', states.join(','));
  check(chains[0] === chains[1], 'both nodes hold an identical chain');
  check(chains[0].split('|').length === 2, 'the chain is proposed + confirmed', String(chains[0].split('|').length));

  // M-7 at the boundary: the counterparty received hashes, never the commitment text.
  const edge = b.vault.getEdge(b.personaId, edgeId);
  check(
    b.vault.getCommitment(b.personaId, edge.commitment_hash) === null,
    'B never received the commitment plaintext',
  );

  process.stdout.write(
    `${JSON.stringify({ ok: failures.length === 0, edge_id: edgeId, states, failures })}\n`,
  );
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, failures: [`threw: ${err?.stack ?? err}`] })}\n`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) process.exitCode = 1;
