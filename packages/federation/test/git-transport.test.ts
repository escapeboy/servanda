import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signMessage } from '../src/messages.js';
import { makePair, type Pair } from './support/fixture.js';

/**
 * §6.1 git transport. Everything here runs against a LOCAL bare repository — the two clones
 * exchange messages by path, so "offline-tolerant" is the default case rather than a mode.
 */

let pair: Pair;
let edgeId: string;

beforeAll(async () => {
  pair = makePair();
  edgeId = pair.a.node.commit({
    intent: 'write the transport test',
    owed_to: pair.b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await pair.a.fed.push();
});
afterAll(() => pair.cleanup());

const cloneDir = (label: string) => join(pair.root, `${label}-clone`, 'servanda');

describe('§6.1 git transport', () => {
  it('lays messages out as servanda/{edge_id}/{seq}-{type}.json', () => {
    const dir = join(cloneDir('a'), edgeId);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual(['0001-propose.json']);
    const message = JSON.parse(readFileSync(join(dir, '0001-propose.json'), 'utf8'));
    expect(message.type).toBe('propose');
    expect(message.sender).toBe(pair.a.personaId);
  });

  it('sync is fetch/push against a local repository — no remote host anywhere', async () => {
    expect(pair.shared).toContain('shared.git');
    await pair.b.fed.pull();
    expect(existsSync(join(cloneDir('b'), edgeId, '0001-propose.json'))).toBe(true);
    expect(pair.b.vault.getEdge(pair.b.personaId, edgeId)).not.toBeNull();
  });

  it('a second push places the next sequence number, and replays are not re-sent', async () => {
    pair.b.node.confirm({ id: edgeId, decision: 'confirm' });
    await pair.b.fed.push();
    await pair.b.fed.push(); // idempotent: nothing new to place
    await pair.a.fed.pull();
    expect(readdirSync(join(cloneDir('a'), edgeId)).sort()).toEqual([
      '0001-propose.json',
      '0002-assert.json',
    ]);
  });

  it('a file whose signature does not verify never surfaces', async () => {
    const path = join(cloneDir('b'), edgeId, '0001-propose.json');
    const message = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...message, sent_at: '2030-01-01T00:00:00Z' }));
    const delivered = await pair.b.transport.receive(pair.b.personaId);
    expect(delivered.some((m) => m.type === 'propose')).toBe(false);
  });

  it('non-edge-scoped messages are addressed under _direct/{recipient}', async () => {
    const message = signMessage(
      'recon_request',
      { edges: [] },
      pair.a.personaId,
      pair.b.personaId,
      '2026-07-25T11:00:00Z',
      pair.a.privateKey,
    );
    await pair.a.transport.send(pair.b.personaId, message);
    await pair.a.transport.sync();
    expect(readdirSync(join(cloneDir('a'), '_direct', pair.b.personaId))).toEqual([
      '0001-recon_request.json',
    ]);

    await pair.b.transport.sync();
    const delivered = await pair.b.transport.receive(pair.b.personaId);
    expect(delivered.map((m) => m.type)).toContain('recon_request');

    // …and it is not delivered to anyone else, even though the repository is shared.
    const toSomeoneElse = await pair.b.transport.receive(pair.a.personaId);
    expect(toSomeoneElse.map((m) => m.type)).not.toContain('recon_request');
  });
});
