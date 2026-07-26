import { describe, expect, it } from 'vitest';
import {
  DomainAnchorResolver,
  anchorsOrgRoot,
  isAnchorableDomain,
  parseAnchorTxt,
  txtName,
  wellKnownUrl,
} from '../src/index.js';
import {
  ORG,
  OTHER_ORG,
  anchorDocument,
  anchorTxt,
  fixedClock,
  stepClock,
  txtTransport,
  unreachableTransport,
  wellKnownTransport,
} from './support/fixture.js';

const CLOCK = fixedClock('2026-03-01T00:00:00Z');

describe('§1.5 domain anchor', () => {
  it('builds the two documented locations', () => {
    expect(wellKnownUrl('acme.com')).toBe('https://acme.com/.well-known/servanda.json');
    expect(txtName('acme.com')).toBe('_servanda.acme.com');
  });

  it('refuses anything that is not a bare hostname', () => {
    for (const bad of [
      'https://acme.com',
      'acme.com/path',
      'acme.com:8443',
      'user@acme.com',
      'acme',
      '',
      'a..b',
      '-acme.com',
      'acme.com ',
      '127.0.0.1:1/x',
    ]) {
      expect(isAnchorableDomain(bad), bad).toBe(false);
    }
    expect(isAnchorableDomain('acme.com')).toBe(true);
    expect(isAnchorableDomain('hub.acme.co.uk')).toBe(true);
  });

  it('fails closed with no transport injected — an unconfigured verifier claims nothing', async () => {
    const res = await new DomainAnchorResolver({ clock: CLOCK }).resolve('acme.com');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-transport');
  });

  it('resolves the .well-known document', async () => {
    const transport = wellKnownTransport(anchorDocument(ORG.id, ['https://hub.acme.com/servanda']));
    const res = await new DomainAnchorResolver({ transport, clock: CLOCK }).resolve('acme.com');
    expect(res.ok).toBe(true);
    expect(res.anchor?.org_root).toBe(ORG.id);
    expect(res.anchor?.hubs).toEqual(['https://hub.acme.com/servanda']);
    expect(res.sources).toEqual(['well-known']);
    expect(transport.calls).toEqual(['https://acme.com/.well-known/servanda.json']);
  });

  it('resolves the DNS TXT record', async () => {
    const transport = txtTransport([anchorTxt(ORG.id)]);
    const res = await new DomainAnchorResolver({ transport, clock: CLOCK }).resolve('acme.com');
    expect(res.ok).toBe(true);
    expect(res.anchor?.org_root).toBe(ORG.id);
    expect(res.sources).toEqual(['dns']);
    expect(transport.calls).toEqual(['_servanda.acme.com']);
  });

  it('parses only the exact §1.5 TXT shape', () => {
    expect(parseAnchorTxt(`v=servanda0.1; k=${ORG.id}`)?.org_root).toBe(ORG.id);
    expect(parseAnchorTxt(`v=servanda0.1;k=${ORG.id}`)?.org_root).toBe(ORG.id);
    for (const bad of [
      `v=servanda0.2; k=${ORG.id}`,
      `v=servanda/0.1; k=${ORG.id}`,
      'v=servanda0.1',
      `k=${ORG.id}`,
      `v=servanda0.1; k=${ORG.id.toUpperCase()}`,
      'v=servanda0.1; k=nothex',
      `v=servanda0.1; v=servanda0.1; k=${ORG.id}`,
      'some unrelated txt record',
    ]) {
      expect(parseAnchorTxt(bad), bad).toBeNull();
    }
  });

  it('reports unreachable separately from absent', async () => {
    const unreachable = await new DomainAnchorResolver({
      transport: unreachableTransport(),
      clock: CLOCK,
    }).resolve('acme.com');
    expect(unreachable.reason).toBe('unreachable');

    const absent = await new DomainAnchorResolver({
      transport: { resolveTxt: async () => [{ value: 'v=spf1 -all', ttlSeconds: 300 }] },
      clock: CLOCK,
    }).resolve('acme.com');
    expect(absent.reason).toBe('absent');
  });

  it('reports a served-but-unparseable document as malformed', async () => {
    const res = await new DomainAnchorResolver({
      transport: wellKnownTransport('<html>404</html>'),
      clock: CLOCK,
    }).resolve('acme.com');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('malformed');
  });

  it('treats a non-200 as absent, not as an anchor', async () => {
    const res = await new DomainAnchorResolver({
      transport: wellKnownTransport(anchorDocument(), { status: 404 }),
      clock: CLOCK,
    }).resolve('acme.com');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('absent');
  });

  it('refuses when .well-known and DNS disagree, rather than picking a winner', async () => {
    const transport = {
      ...wellKnownTransport(anchorDocument(ORG.id)),
      ...txtTransport([anchorTxt(OTHER_ORG.id)]),
    };
    const res = await new DomainAnchorResolver({ transport, clock: CLOCK }).resolve('acme.com');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('conflict');
    expect(res.anchor).toBeNull();
  });

  it('accepts both sources when they agree', async () => {
    const transport = {
      ...wellKnownTransport(anchorDocument(ORG.id)),
      ...txtTransport([anchorTxt(ORG.id)]),
    };
    const res = await new DomainAnchorResolver({ transport, clock: CLOCK }).resolve('acme.com');
    expect(res.ok).toBe(true);
    expect(res.sources).toEqual(['dns', 'well-known']);
  });

  describe('caching against an injected clock', () => {
    it('serves from cache until the resource TTL elapses, then re-resolves', async () => {
      const clock = stepClock('2026-03-01T00:00:00Z');
      const transport = wellKnownTransport(anchorDocument(ORG.id), { ttlSeconds: 600 });
      const resolver = new DomainAnchorResolver({ transport, clock });

      await resolver.resolve('acme.com');
      await resolver.resolve('acme.com');
      expect(transport.calls).toHaveLength(1);

      clock.advance(599);
      await resolver.resolve('acme.com');
      expect(transport.calls).toHaveLength(1);

      clock.advance(2);
      await resolver.resolve('acme.com');
      expect(transport.calls).toHaveLength(2);
    });

    it('does not cache when the resource states no TTL', async () => {
      const clock = stepClock('2026-03-01T00:00:00Z');
      const transport = wellKnownTransport(anchorDocument(ORG.id), { ttlSeconds: null });
      const resolver = new DomainAnchorResolver({ transport, clock });
      await resolver.resolve('acme.com');
      await resolver.resolve('acme.com');
      expect(transport.calls).toHaveLength(2);
      expect(resolver.cacheSize).toBe(0);
    });

    it('never caches a failure — a verifier that could not reach the anchor tries again', async () => {
      const clock = stepClock('2026-03-01T00:00:00Z');
      let attempts = 0;
      const resolver = new DomainAnchorResolver({
        transport: {
          fetchWellKnown: async () => {
            attempts++;
            return attempts < 3 ? null : { status: 200, body: JSON.stringify(anchorDocument()), ttlSeconds: 600 };
          },
        },
        clock,
      });
      expect((await resolver.resolve('acme.com')).ok).toBe(false);
      expect((await resolver.resolve('acme.com')).ok).toBe(false);
      expect((await resolver.resolve('acme.com')).ok).toBe(true);
      expect(attempts).toBe(3);
    });

    it('uses the shortest TTL among contributing sources', async () => {
      const clock = stepClock('2026-03-01T00:00:00Z');
      const transport = {
        ...wellKnownTransport(anchorDocument(ORG.id), { ttlSeconds: 3600 }),
        ...txtTransport([anchorTxt(ORG.id)], { ttlSeconds: 60 }),
      };
      const resolver = new DomainAnchorResolver({ transport, clock });
      const res = await resolver.resolve('acme.com');
      expect(res.expiresAt).toBe(clock.now().getTime() + 60_000);
    });
  });

  it('anchorsOrgRoot is exact — an anchor for another org proves nothing', async () => {
    const res = await new DomainAnchorResolver({
      transport: wellKnownTransport(anchorDocument(OTHER_ORG.id)),
      clock: CLOCK,
    }).resolve('acme.com');
    expect(anchorsOrgRoot(res, OTHER_ORG.id)).toBe(true);
    expect(anchorsOrgRoot(res, ORG.id)).toBe(false);
    expect(anchorsOrgRoot(null, ORG.id)).toBe(false);
  });

  it('does no I/O when a transport throws — an exception is an unreachable anchor', async () => {
    const res = await new DomainAnchorResolver({
      transport: {
        fetchWellKnown: async () => {
          throw new Error('EAI_AGAIN');
        },
      },
      clock: CLOCK,
    }).resolve('acme.com');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unreachable');
  });
});
