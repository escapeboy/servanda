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
