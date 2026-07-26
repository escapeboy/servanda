import { describe, expect, it } from 'vitest';
import {
  COPY,
  FixtureNodeClient,
  briefEl,
  loadApp,
  makeFixture,
  renderToHtml,
  scanAll,
  visibleText,
} from '@servanda/client-web';
import { briefHtml, briefText, renderBriefEmail } from '../src/index.js';

const NOW = '2026-03-01T09:00:00Z';

async function brief() {
  const fixture = makeFixture(24, NOW);
  const client = new FixtureNodeClient(fixture);
  const app = await loadApp(client, { surface: 'brief', now: NOW, pending: { items: fixture.pending } });
  return app.brief;
}

/**
 * "Identical content to the in-app Brief; one renderer contract." The test is set equality
 * against the app's own brief, not a spot check — a second implementation would show up
 * here as a line the app has and the email does not, or the reverse.
 */
describe('the morning note is the in-app brief, projected', () => {
  it('carries every line the app shows, in the app’s order', async () => {
    const view = await brief();
    const inApp = visibleText(briefEl(view));
    const text = briefText(view);
    for (const line of inApp) expect(text).toContain(line);

    let cursor = -1;
    for (const line of inApp) {
      const at = text.indexOf(line, cursor);
      expect(at).toBeGreaterThan(-1);
      cursor = at;
    }
  });

  it('uses the app’s own element tree for the HTML part', async () => {
    const view = await brief();
    expect(briefHtml(view)).toContain(renderToHtml(briefEl(view)));
  });

  it('adds nothing to the brief but the reason it arrived', async () => {
    const view = await brief();
    const pieces = visibleText(briefEl(view));
    // A line is either verbatim from the app, composed of the app's own pieces, or one of
    // the two lines an email is entitled to: why it arrived, and why you are getting it.
    const unaccounted = briefText(view)
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => !pieces.includes(line))
      .filter((line) => !pieces.some((piece) => line.includes(piece)));
    expect(unaccounted).toEqual([COPY.email.intro, COPY.email.footer]);
  });

  it('states counts in the subject without dressing them up', async () => {
    const view = await brief();
    const email = renderBriefEmail(view);
    expect(email.subject).toBe(`${view.counts.owe} owed, ${view.counts.waiting} waiting`);
    expect(email.subject).not.toContain('!');
  });

  it('speaks no machinery vocabulary and raises its voice at nobody', async () => {
    const view = await brief();
    const email = renderBriefEmail(view);
    expect(scanAll([email.subject, ...email.text.split('\n')])).toEqual([]);
  });

  it('needs no network to render: the stylesheet travels with it', async () => {
    const html = briefHtml(await brief());
    expect(html).toContain('<style>');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('url(');
  });

  it('shows every name with the evidence behind it (M-12)', async () => {
    const view = await brief();
    const text = briefText(view);
    for (const card of view.cards) {
      if (card.withWhom === null) continue;
      expect(text).toContain(`${card.withWhom.display} · ${card.withWhom.trust.label}`);
    }
  });

  it('renders the same bytes for the same brief', async () => {
    const view = await brief();
    expect(JSON.stringify(renderBriefEmail(view))).toBe(JSON.stringify(renderBriefEmail(view)));
  });

  it('says so plainly when there is nothing', async () => {
    const view = await brief();
    const emptyView = { ...view, cards: [], belowTheLine: null };
    expect(briefText(emptyView)).toContain(COPY.brief.empty);
    expect(scanAll(briefText(emptyView).split('\n'))).toEqual([]);
    expect(briefHtml(emptyView)).toContain(COPY.brief.empty);
  });
});
