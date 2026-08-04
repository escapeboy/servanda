import { describe, expect, it } from 'vitest';
import { FixtureNodeClient, loadApp, makeFixture } from '@servanda/client-web';
import { frameLines } from '../src/frame.js';

const NOW = '2026-03-01T09:00:00Z';

/**
 * The terminal says the same thing the browser says about whether this is the whole register.
 *
 * Two surfaces, one view model, and historically that has NOT been enough: `unresolvedLine` was
 * on the model and rendered in one place. A parity test is the only thing that keeps the second
 * surface honest, because a person on the TUI never sees the browser and cannot notice the gap.
 */
describe('the terminal reports its reach too', () => {
  it('says nothing when the register was read whole', async () => {
    const client = new FixtureNodeClient(makeFixture(24, NOW));
    const app = await loadApp(client, { surface: 'owe', now: NOW });
    expect(app.reach.line).toBeNull();
    const lines = frameLines({ app, cursor: 0 });
    expect(lines.join('\n')).not.toContain('Showing');
  });

  it('and prints the line when the walk stopped short', async () => {
    const client = new FixtureNodeClient(makeFixture(24, NOW));
    const app = await loadApp(client, { surface: 'owe', now: NOW });
    const short = { ...app, reach: { ...app.reach, complete: false, line: 'Showing 40 of 99999.' } };
    const lines = frameLines({ app: short, cursor: 0 });
    expect(lines.join('\n')).toContain('Showing 40 of 99999.');
  });
});

const DESKTOP = { m: 1_048_576, t: 2, p: 4 };
const FLOOR = { m: 65_536, t: 3, p: 1 };
const COMMAND = 'SERVANDA_UPGRADE_KEY=1 servanda-init';

/**
 * The terminal says the same three things the browser says.
 *
 * Not assumed from the shared view model — `frame.ts` is a second renderer and has already been
 * caught rendering one line and not another. Every notice needs its own parity test or six of
 * them will be right and the seventh will be silent for a person who never opens a browser.
 */
describe('the terminal carries the notices too', () => {
  it('prints the weak-setup notice, reassurance first, with the command', async () => {
    const client = new FixtureNodeClient(makeFixture(6, NOW));
    const app = await loadApp(client, {
      surface: 'owe',
      now: NOW,
      vault: { profile: FLOOR, current: DESKTOP, command: COMMAND },
    });
    const text = frameLines({ app, cursor: 0 }).join('\n');
    expect(text).toContain(app.vault.reassurance!);
    expect(text).toContain(COMMAND);
    expect(text.indexOf(app.vault.reassurance!)).toBeLessThan(text.indexOf(app.vault.line!));
  });

  it('prints the undeliverable message, and names who cannot be reached', async () => {
    const client = new FixtureNodeClient(makeFixture(6, NOW));
    const app = await loadApp(client, {
      surface: 'owe',
      now: NOW,
      delivery: { items: [{ id: 'c', recipient: 'Boyan', state: 'unroutable', attempts: 0 }] },
    });
    const text = frameLines({ app, cursor: 0 }).join('\n');
    expect(text).toContain(app.delivery.line!);
    expect(text).toContain('Boyan');
  });

  it('and stays quiet when there is nothing to say', async () => {
    const client = new FixtureNodeClient(makeFixture(6, NOW));
    const app = await loadApp(client, { surface: 'owe', now: NOW });
    const text = frameLines({ app, cursor: 0 }).join('\n');
    expect(text).not.toContain('older version');
    expect(text).not.toContain('Messages out');
  });
});
