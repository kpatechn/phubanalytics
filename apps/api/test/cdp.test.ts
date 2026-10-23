import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CdpExample, CdpPlayer, CdpSegmentsData, CdpSitesData, Property } from '@phub/contracts';
import { buildApp } from '../src/app.js';
import { jwtAuthenticator } from '../src/auth.js';
import type { CdpMetaBase, CdpRepo } from '../src/cdp.js';
import type { AnalyticsRepo } from '../src/repo.js';

const property: Property = { tenantId: 15001, propertyId: 1500001, name: 'Graton', timeZone: 'America/Los_Angeles', environment: 'dev' };
const analytics = { ping: async () => {}, properties: async () => [property] } as unknown as AnalyticsRepo;

const meta: CdpMetaBase = {
  client: 'Chickasaw',
  asOfDate: '2025-07-04',
  windowFrom: '2024-07-05',
  refreshedAt: '2026-10-23T20:00:00.000Z',
  feeds: [{ code: 'mock_hotel', area: 'non_gaming', source: 'cdp_mock.hotel_stay', isMock: true, notes: 'stand-in' }],
  sites: [{ code: 'WINSTAR', name: 'WinStar World Casino and Resort', gamingIsMock: false }],
};

function fakeCdp(overrides: Partial<CdpRepo> = {}): CdpRepo & { calls: Record<string, number>; looked: string[] } {
  const calls: Record<string, number> = { segments: 0, sites: 0 };
  const looked: string[] = [];
  return {
    calls,
    looked,
    meta: async () => meta,
    segments: async () => {
      calls['segments']!++;
      return { totals: { players: 3, active: 2, marketable: 1, multiSite: 1, selfExcluded: 0, appLinked: 1 }, channels: [], segments: [] } satisfies CdpSegmentsData;
    },
    sites: async () => {
      calls['sites']!++;
      return { sites: [], crossVisits: [] } satisfies CdpSitesData;
    },
    examples: async (segment) => (segment === 'champions' ? ([{ accountNumber: '1001', tierName: 'ELITE', homeSite: 'WINSTAR', combinedValue: 12 }] satisfies CdpExample[]) : null),
    player: async (accountNumber) => {
      looked.push(accountNumber);
      return accountNumber === '1001' ? ({ accountNumber } as CdpPlayer) : null;
    },
    ...overrides,
  };
}

describe('CDP API', () => {
  let sign: (roles: string[]) => Promise<string>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  const cdp = fakeCdp();
  const now = () => new Date('2026-10-23T21:00:00Z');
  let app: Awaited<ReturnType<typeof buildApp>>;
  let bare: Awaited<ReturnType<typeof buildApp>>;

  const build = (cdpRepo: CdpRepo | undefined) =>
    buildApp({
      config: { AUTH_MODE: 'jwt', ALLOWED_ORIGIN: undefined },
      repo: analytics,
      cdp: cdpRepo,
      now,
      authenticate: jwtAuthenticator({ keys, issuer: 'https://idp.test/', audience: 'analytics', rolesClaim: 'roles' }),
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256' }] });
    sign = (roles) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: 'ES256', kid: 'test' })
        .setSubject('user-1')
        .setIssuer('https://idp.test/')
        .setAudience('analytics')
        .setExpirationTime('5m')
        .sign(privateKey);
    app = await build(cdp);
    bare = await build(undefined);
  });

  afterAll(async () => {
    await app.close();
    await bare.close();
  });

  const get = (target: typeof app, url: string, token?: string) =>
    target.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const lookup = (body: unknown, token: string, target = app) =>
    target.inject({ method: 'POST', url: '/api/cdp/players/lookup', headers: { authorization: `Bearer ${token}` }, payload: body as object });

  it('needs a token, then the analytics:cdp role', async () => {
    expect((await get(app, '/api/cdp/segments')).statusCode).toBe(401);
    const exec = await get(app, '/api/cdp/segments', await sign(['analytics:exec']));
    expect(exec.statusCode).toBe(403);
    expect(exec.headers['content-type']).toContain('application/problem+json');
    expect((await get(app, '/api/cdp/segments', await sign(['analytics:cdp']))).statusCode).toBe(200);
    expect((await get(app, '/api/cdp/sites', await sign(['analytics:admin']))).statusCode).toBe(200);
  });

  it('lists the cdp view only when the CDP is configured', async () => {
    const token = await sign(['analytics:admin']);
    expect((await get(app, '/api/analytics/me', token)).json().views).toEqual(['executive', 'engagement', 'marketing', 'it', 'cdp']);
    expect((await get(bare, '/api/analytics/me', token)).json().views).toEqual(['executive', 'engagement', 'marketing', 'it']);
    expect((await get(bare, '/api/cdp/segments', token)).statusCode).toBe(404);
    expect((await get(app, '/api/analytics/me', await sign(['analytics:cdp']))).json().views).toEqual(['cdp']);
  });

  it('wraps data in the CDP envelope and caches aggregates', async () => {
    const token = await sign(['analytics:cdp']);
    const before = cdp.calls['segments']!;
    const first = await get(app, '/api/cdp/segments', token);
    await get(app, '/api/cdp/segments', token);
    expect(cdp.calls['segments']! - before).toBeLessThanOrEqual(1);
    expect(first.json().meta).toMatchObject({ client: 'Chickasaw', asOfDate: '2025-07-04', generatedAt: '2026-10-23T21:00:00.000Z' });
    expect(first.json().data.totals.players).toBe(3);
    expect(first.headers['cache-control']).toBe('private, max-age=300');
  });

  it('looks players up by POST body only, uncached', async () => {
    const token = await sign(['analytics:cdp']);
    const found = await lookup({ accountNumber: ' 1001 ' }, token);
    expect(found.statusCode).toBe(200);
    expect(found.json().data.accountNumber).toBe('1001');
    expect(found.headers['cache-control']).toBe('private, no-store');
    expect((await lookup({ accountNumber: '9999' }, token)).statusCode).toBe(404);
    const bad = await lookup({ accountNumber: '12;DROP' }, token);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].path).toBe('accountNumber');
    expect((await lookup({}, token)).statusCode).toBe(400);
    expect((await get(app, '/api/cdp/players/lookup', token)).statusCode).toBe(404);
    expect(cdp.looked).toEqual(['1001', '9999']);
  });

  it('lists example players for a known segment', async () => {
    const token = await sign(['analytics:cdp']);
    const res = await get(app, '/api/cdp/players/examples?segment=champions', token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect((await get(app, '/api/cdp/players/examples?segment=nope', token)).statusCode).toBe(404);
    expect((await get(app, '/api/cdp/players/examples?segment=Bad%20Code', token)).statusCode).toBe(400);
  });

  it('answers 503 until the CDP has been built', async () => {
    const unbuilt = await build(fakeCdp({ meta: async () => null }));
    const res = await get(unbuilt, '/api/cdp/meta', await sign(['analytics:cdp']));
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toContain('build-cdp.sh');
    await unbuilt.close();
  });
});
