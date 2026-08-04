import { describe, expect, it } from 'vitest';
import { FixtureNodeClient, loadApp, makeFixture } from '../src/index.js';
import { appEl } from '../src/render.js';
import { renderToHtml, visibleText } from '../src/element.js';
import { buildDelivery, buildVaultStrength, type DeliveryFact } from '../src/warnings.js';
import { scanAll } from '../src/vocabulary.js';

const NOW = '2026-03-01T09:00:00Z';
const DESKTOP = { m: 1_048_576, t: 2, p: 4 };
const FLOOR = { m: 65_536, t: 3, p: 1 };
const COMMAND = 'SERVANDA_UPGRADE_KEY=1 servanda-init';

const app = (extra: Record<string, unknown> = {}) =>
  loadApp(new FixtureNodeClient(makeFixture(6, NOW)), { surface: 'owe', now: NOW, ...extra });

/**
 * Two things the node has always known and no shipped surface ever said.
 *
 * `Vault.kdfProfile()` returned `behindDefault: true` from the moment the default was raised,
 * and a grep for its callers outside tests found exactly one: itself. `OutboundStatus` carries a
 * whole sentence about a message that will never arrive, inside a package no client imports. A
 * fact with no surface cannot be told apart from an absent fact.
 */
describe('a weaker-than-today vault reaches its owner', () => {
  it('says nothing when the profile is current — silence is the normal case', async () => {
    const view = await app({ vault: { profile: DESKTOP, current: DESKTOP, command: COMMAND } });
    expect(view.vault.weak).toBe(false);
    expect(view.vault.line).toBeNull();
  });

  it('and nothing when the profile cannot be read, rather than guessing', async () => {
    const view = await app({ vault: { profile: null, current: DESKTOP, command: COMMAND } });
    expect(view.vault.weak).toBe(false);
  });

  it('reports the published floor as 16x less memory', async () => {
    const view = await app({ vault: { profile: FLOOR, current: DESKTOP, command: COMMAND } });
    expect(view.vault.weak).toBe(true);
    expect(view.vault.memoryFactor).toBe(16);
    // Memory and work are separate numbers because they buy different things — and the gap
    // between 16 and 43 is the point §9.3 makes about which one decides the attack.
    expect(view.vault.workFactor).toBe(43);
  });

  it('leads with the reassurance, then the cost, then the command', async () => {
    const view = await app({ vault: { profile: FLOOR, current: DESKTOP, command: COMMAND } });
    const text = visibleText(appEl(view));
    const joined = text.join('\n');
    // Order is the design. A notice that reads like a breach gets a vault deleted by somebody
    // trying to be safe, and there is nothing here to be safe from.
    expect(joined.indexOf(view.vault.reassurance!)).toBeLessThan(joined.indexOf(view.vault.line!));
    expect(joined).toContain(COMMAND);
  });

  it('and never says a word the person would have to look up', async () => {
    const view = await app({ vault: { profile: FLOOR, current: DESKTOP, command: COMMAND } });
    expect(scanAll(visibleText(appEl(view)))).toEqual([]);
    // The one term a security notice must not need is the name of the thing it is about.
    expect(visibleText(appEl(view)).join(' ')).not.toMatch(/argon|kdf|kib|\bm=/iu);
  });
});

const out = (state: DeliveryFact['state'], id: string, attempts = 0): DeliveryFact => ({
  id,
  recipient: 'Boyan',
  state,
  attempts,
});

describe('a message that will never arrive says so', () => {
  it('stays silent when everything is accounted for', () => {
    const view = buildDelivery({ items: [out('acknowledged', 'a'), out('sent', 'b')] });
    expect(view.line).toBeNull();
  });

  it('counts only what a person can act on', () => {
    const view = buildDelivery({
      items: [out('acknowledged', 'a'), out('sent', 'b'), out('unroutable', 'c'), out('queued', 'd', 3)],
    });
    expect(view.line).toContain('2 messages');
    expect(view.entries.filter((e) => e.needsYou).map((e) => e.id)).toEqual(['c', 'd']);
  });

  it('never words `sent` as delivered — that is the whole distinction', () => {
    const view = buildDelivery({ items: [out('sent', 'b'), out('acknowledged', 'a')] });
    const sent = view.entries.find((e) => e.state === 'sent')!;
    const ack = view.entries.find((e) => e.state === 'acknowledged')!;
    // A git push proves bytes reached a repository; a 200 proves a relay took a sealed blob it
    // cannot read. Only a signature proves a person has it.
    expect(sent.line).not.toMatch(/delivered|has it|received/iu);
    expect(sent.line).toMatch(/no word back|nobody knows/iu);
    expect(ack.line).toMatch(/signed/iu);
  });

  it('and the unreachable counterparty is named, with the reason', () => {
    const view = buildDelivery({ items: [out('unroutable', 'c')] });
    const entry = view.entries[0]!;
    expect(entry.line).toContain('Boyan');
    expect(entry.line).toMatch(/different transports/iu);
  });

  it('is rendered, not merely computed', async () => {
    const view = await app({ delivery: { items: [out('unroutable', 'c')] } });
    const html = renderToHtml(appEl(view));
    expect(html).toContain(view.delivery.line!);
    expect(html).toContain(view.delivery.entries[0]!.line);
  });
});

describe('the guards themselves', () => {
  it('a profile equal in memory but cheaper in work is still reported, and reads sensibly', () => {
    // The rounding edge: memoryFactor is 1 here, so the numeric sentence would read
    // "roughly 1 times less". The copy has a second variant for exactly this.
    const view = buildVaultStrength({
      profile: { m: DESKTOP.m, t: 1, p: 1 },
      current: DESKTOP,
      command: COMMAND,
    });
    expect(view.weak).toBe(true);
    expect(view.memoryFactor).toBe(1);
    expect(view.line).not.toMatch(/1 times/u);
    expect(view.line).toMatch(/slightly cheaper/u);
  });
});
