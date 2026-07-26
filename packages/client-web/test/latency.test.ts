import { describe, expect, it } from 'vitest';
import {
  FixtureNodeClient,
  appEl,
  loadApp,
  makeFixture,
  renderToHtml,
} from '../src/index.js';
import { NOW } from './fixture.js';

/**
 * The latency budget: the brief renders in under 100 ms from a local node.
 *
 * Measured end to end — both tool calls, the view model, the element tree and the
 * serialisation — over a full register at §7's `limit` ceiling of 500 items. The assertion
 * is on the WORST of the runs, cold first run included, so a regression fails the gate
 * rather than hiding behind a median.
 */

const BUDGET_MS = 100;
const RUNS = 20;
const REGISTER_SIZE = 500;

async function renderBriefOnce(client: FixtureNodeClient, pending: ReturnType<FixtureNodeClient['pendingLoops']>) {
  const app = await loadApp(client, { surface: 'brief', now: NOW, pending });
  return renderToHtml(appEl(app));
}

describe('the brief renders inside its latency budget', () => {
  it(`renders a ${REGISTER_SIZE}-item register in under ${BUDGET_MS} ms, worst run`, async () => {
    const fixture = makeFixture(REGISTER_SIZE, NOW);
    const client = new FixtureNodeClient(fixture);
    const pending = client.pendingLoops();

    const timings: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      const html = await renderBriefOnce(client, pending);
      timings.push(performance.now() - started);
      expect(html.length).toBeGreaterThan(0);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const worst = sorted[sorted.length - 1] ?? Infinity;
    const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
    // Printed so the gate's number and this test's number are the same measurement.
    console.log(
      `brief render over ${REGISTER_SIZE} items: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms, budget ${BUDGET_MS} ms`,
    );
    expect(worst).toBeLessThan(BUDGET_MS);
  });
});
