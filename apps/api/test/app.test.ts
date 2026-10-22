import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngagementData, ExecutiveData, ItData, MarketingData, Property } from '@phub/contracts';
import { buildApp } from '../src/app.js';
import { jwtAuthenticator } from '../src/auth.js';
import type { AnalyticsRepo } from '../src/repo.js';

const property: Property = { tenantId: 15001, propertyId: 1500001, name: 'Graton', timeZone: 'America/Los_Angeles', environment: 'dev' };
const zeroKpis = { sessions: 0, appOpens: 0, loginStarted: 0, loginSuccess: 0, playersLoggedIn: 0, activeGuests: 0, onsiteEvents: 0, apiErrors: 0, totalEvents: 0 };

function fakeRepo(): AnalyticsRepo & { calls: Record<string, number> } {
  const calls: Record<string, number> = { executive: 0, engagement: 0, marketing: 0, it: 0 };
  const asOfSeen: string[] = [];
  return {
    calls,
    ping: async () => {},
    properties: async () => [property],
    freshness: async () => ({ latestEventAt: new Date('2026-10-21T23:24:53Z'), lastSuccessAt: new Date('2026-10-22T17:55:00Z'), queuedHours: 0, oldestQueuedAt: null, dextransRefreshedAt: new Date('2026-10-22T17:45:00Z') }),
    executive: async () => {
      calls['executive']!++;
      return { kpis: { ...zeroKpis, sessions: 186 }, previous: zeroKpis, daily: [], features: [] } satisfies ExecutiveData;
    },
    engagement: async (_scope, _previous, asOf) => {
      calls['engagement']!++;
      asOfSeen.push(asOf);
      return { asOf } as unknown as EngagementData;
    },
    marketing: async () => {
      calls['marketing']!++;
      return {} as MarketingData;
    },
    it: async () => {
      calls['it']!++;
      return {} as ItData;
    },
  };
}

describe('analytics API', () => {
  let sign: (roles: string[]) => Promise<string>;
  let otherKeyToken: string;
  const repo = fakeRepo();
  const now = () => new Date('2026-10-22T18:00:00Z');
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256' };
    sign = (roles) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: 'ES256', kid: 'test' })
        .setSubject('user-1')
        .setIssuer('https://idp.test/')
        .setAudience('analytics')
        .setExpirationTime('5m')
        .sign(privateKey);
    const other = await generateKeyPair('ES256');
    otherKeyToken = await new SignJWT({ roles: ['analytics:admin'] })
      .setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setIssuer('https://idp.test/')
      .setAudience('analytics')
      .setExpirationTime('5m')
      .sign(other.privateKey);

    app = await buildApp({
      config: { AUTH_MODE: 'jwt', ALLOWED_ORIGIN: undefined },
      repo,
      now,
      authenticate: jwtAuthenticator({
        keys: createLocalJWKSet({ keys: [jwk] }),
        issuer: 'https://idp.test/',
        audience: 'analytics',
        rolesClaim: 'roles',
      }),
    });
  });

  afterAll(() => app.close());

  const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

  it('returns 401 problem without a token', async () => {
    const res = await get('/api/analytics/executive');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, title: 'Unauthorized' });
  });

  it('returns 401 for a token signed by another key', async () => {
    expect((await get('/api/analytics/executive', otherKeyToken)).statusCode).toBe(401);
  });

  it('returns 403 for the wrong role', async () => {
    const res = await get('/api/analytics/it', await sign(['analytics:marketing']));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 403 });
  });

  it('returns 200 with the envelope for the right role', async () => {
    const res = await get('/api/analytics/executive?from=2026-09-03&to=2026-10-02', await sign(['analytics:exec']));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({
      from: '2026-09-03',
      to: '2026-10-02',
      previousFrom: '2026-08-04',
      previousTo: '2026-09-02',
      source: 'rollup',
      property: { propertyId: 1500001, timeZone: 'America/Los_Angeles' },
      dataAsOf: '2026-10-21T23:24:53.000Z',
      dextransAsOf: '2026-10-22T17:45:00.000Z',
    });
    expect(body.data.kpis.sessions).toBe(186);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it('lets admins see every view and reports their views', async () => {
    const token = await sign(['analytics:admin']);
    for (const view of ['executive', 'engagement', 'marketing', 'it']) {
      expect((await get(`/api/analytics/${view}`, token)).statusCode).toBe(200);
    }
    expect((await get('/api/analytics/me', token)).json()).toMatchObject({ views: ['executive', 'engagement', 'marketing', 'it'], authMode: 'jwt' });
  });

  it('serves engagement to the exec role, with today in the property time zone', async () => {
    const exec = await sign(['analytics:exec']);
    const res = await get('/api/analytics/engagement?from=2026-09-03&to=2026-10-02', exec);
    expect(res.statusCode).toBe(200);
    // 18:00 UTC on Oct 22 is still Oct 22 in Los Angeles.
    expect(res.json().data).toEqual({ asOf: '2026-10-22' });
    expect((await get('/api/analytics/engagement', await sign(['analytics:marketing']))).statusCode).toBe(403);
  });

  it('defaults to the last 30 days with a short cache for open ranges', async () => {
    const res = await get('/api/analytics/marketing', await sign(['analytics:marketing']));
    expect(res.json().meta).toMatchObject({ from: '2026-09-23', to: '2026-10-22' });
    expect(res.headers['cache-control']).toBe('private, max-age=60');
  });

  it('caches identical requests and answers If-None-Match with 304', async () => {
    const token = await sign(['analytics:it']);
    const before = repo.calls['it']!;
    const first = await get('/api/analytics/it?from=2026-10-01&to=2026-10-07', token);
    const second = await get('/api/analytics/it?from=2026-10-01&to=2026-10-07', token, { 'if-none-match': first.headers['etag'] as string });
    expect(repo.calls['it']! - before).toBe(1);
    expect(second.statusCode).toBe(304);
  });

  it('rejects bad parameters with field errors', async () => {
    const token = await sign(['analytics:exec']);
    const bad = await get('/api/analytics/executive?from=2026-02-30', token);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual([{ path: 'from', message: 'must be a date as YYYY-MM-DD' }]);
    expect((await get('/api/analytics/executive?from=2026-10-02&to=2026-09-03', token)).statusCode).toBe(400);
    expect((await get('/api/analytics/executive?property=42', token)).statusCode).toBe(404);
  });

  it('reports health and readiness', async () => {
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
    const ready = await get('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
  });

  it('reports stale when the last refresh is too old', async () => {
    const stale = await buildApp({
      config: { AUTH_MODE: 'jwt', ALLOWED_ORIGIN: undefined },
      repo: { ...fakeRepo(), freshness: vi.fn(async () => ({ latestEventAt: null, lastSuccessAt: new Date('2026-10-22T16:00:00Z'), queuedHours: 3, oldestQueuedAt: null, dextransRefreshedAt: null })) },
      now,
      authenticate: async () => null,
    });
    const res = await stale.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('stale');
    await stale.close();
  });
});
