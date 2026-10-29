import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Property, RxMeta, RxRunDetail, RxRunRequest } from '@phub/contracts';
import { buildApp } from '../src/app.js';
import { jwtAuthenticator } from '../src/auth.js';
import { PlanRefused, type RxRepo } from '../src/reinvestment.js';
import type { AnalyticsRepo } from '../src/repo.js';

const property: Property = { tenantId: 15001, propertyId: 1500001, name: 'Graton', timeZone: 'America/Los_Angeles', environment: 'dev' };
const analytics = { ping: async () => {}, properties: async () => [property] } as unknown as AnalyticsRepo;
const PATRON = '0f2b7e1c-3a4d-4e5f-8a9b-0c1d2e3f4a5b';

const meta: RxMeta = {
  tenant: 'chickasaw_sim',
  dataKind: 'mock',
  asOfMonth: '2026-10-01',
  ruleVersion: 'draft-1:draft',
  sites: [{ siteId: 'Y:1', name: 'WinStar' }],
  optimizerEnabled: true,
};

const detail: RxRunDetail = {
  run: {
    runId: 'opt__20261029T120000', createdAt: '2026-10-29T12:00:00Z', status: 'optimal', requestedBy: 'user-1',
    params: { budget: 1000, holdout: 0.1, risk: 'conservative', caps: {}, floors: {}, maxOffers: null },
    spend: 990, profit: 1200, offers: 40, holdoutPatrons: 4, baseline: { spend: 1000, profit: -50, offers: 60 },
    constraints: [], skipped: [],
  },
  allocation: [],
};

function fakeRx(): RxRepo & { planned: { request: RxRunRequest; by: string }[]; looked: string[] } {
  const planned: { request: RxRunRequest; by: string }[] = [];
  const looked: string[] = [];
  return {
    planned,
    looked,
    meta: async () => meta,
    overview: async () => ({ months: [], campaigns: [] }),
    campaign: async (id) => (id === 'C1' ? { campaign: { campaignId: 'C1' } as never, lift: [] } : null),
    patronExamples: async () => [],
    patron: async (id) => {
      looked.push(id);
      return id === PATRON ? ({ patronId: id, reach: [], journey: [] } as never) : null;
    },
    runs: async () => [detail.run],
    run: async (id) => (id === detail.run.runId ? detail : null),
    plan: async (request, by) => {
      if (request.budget === 13) throw new PlanRefused('tenant must be one of [chickasaw_sim]');
      planned.push({ request, by });
      return detail;
    },
  };
}

describe('Reinvestment API', () => {
  let sign: (roles: string[]) => Promise<string>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  const rx = fakeRx();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let bare: Awaited<ReturnType<typeof buildApp>>;

  const build = (repo: RxRepo | undefined) =>
    buildApp({
      config: { AUTH_MODE: 'jwt', ALLOWED_ORIGIN: undefined },
      repo: analytics,
      reinvestment: repo,
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
    app = await build(rx);
    bare = await build(undefined);
  });

  afterAll(async () => {
    await app.close();
    await bare.close();
  });

  const get = (target: typeof app, url: string, token?: string) =>
    target.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const post = (url: string, body: unknown, token: string, target = app) =>
    target.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: body as object });

  it('needs a token, then the marketing role', async () => {
    expect((await get(app, '/api/reinvestment/overview')).statusCode).toBe(401);
    expect((await get(app, '/api/reinvestment/overview', await sign(['analytics:exec']))).statusCode).toBe(403);
    expect((await get(app, '/api/reinvestment/overview', await sign(['analytics:marketing']))).statusCode).toBe(200);
    expect((await get(app, '/api/reinvestment/overview', await sign(['analytics:admin']))).statusCode).toBe(200);
  });

  it('lists the view only when the serving database is configured', async () => {
    const token = await sign(['analytics:marketing']);
    expect((await get(app, '/api/analytics/me', token)).json().views).toEqual(['marketing', 'reinvestment']);
    expect((await get(bare, '/api/analytics/me', token)).json().views).toEqual(['marketing']);
    expect((await get(bare, '/api/reinvestment/overview', token)).statusCode).toBe(404);
  });

  it('says the data is simulated', async () => {
    const res = await get(app, '/api/reinvestment/overview', await sign(['analytics:marketing']));
    expect(res.json().meta).toMatchObject({ tenant: 'chickasaw_sim', dataKind: 'mock' });
  });

  it('takes patron IDs in bodies only and never caches them', async () => {
    const token = await sign(['analytics:marketing']);
    const res = await post('/api/reinvestment/patrons/lookup', { patronId: PATRON }, token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect((await post('/api/reinvestment/patrons/lookup', { patronId: 'not-an-id' }, token)).statusCode).toBe(400);
    expect((await post('/api/reinvestment/patrons/lookup', { patronId: '1b2b7e1c-3a4d-4e5f-8a9b-0c1d2e3f4a5b' }, token)).statusCode).toBe(404);
    expect(rx.looked).not.toContain('not-an-id');
  });

  it('checks campaign and run IDs before using them', async () => {
    const token = await sign(['analytics:marketing']);
    expect((await get(app, '/api/reinvestment/campaigns/C1', token)).statusCode).toBe(200);
    expect((await get(app, "/api/reinvestment/campaigns/C1';drop", token)).statusCode).toBe(400);
    expect((await get(app, '/api/reinvestment/optimizer/runs/opt__20261029T120000', token)).statusCode).toBe(200);
    expect((await get(app, '/api/reinvestment/optimizer/runs/latest', token)).statusCode).toBe(400);
  });

  it('plans with checked inputs and records who asked', async () => {
    const token = await sign(['analytics:marketing']);
    const res = await post('/api/reinvestment/optimizer/runs', { budget: 250000, holdout: 0.1, caps: { 'Y:1': 60000 } }, token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.run.runId).toBe('opt__20261029T120000');
    expect(rx.planned.at(-1)).toEqual({ request: { budget: 250000, holdout: 0.1, caps: { 'Y:1': 60000 } }, by: 'user-1' });
    for (const bad of [{ budget: 0 }, { budget: 1000, holdout: 0.9 }, { budget: 1000, caps: { 'x;y': 5 } }, { budget: 'lots' }]) {
      expect((await post('/api/reinvestment/optimizer/runs', bad, token)).statusCode).toBe(400);
    }
  });

  it('turns an optimizer refusal into a 400', async () => {
    const res = await post('/api/reinvestment/optimizer/runs', { budget: 13 }, await sign(['analytics:marketing']));
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('tenant must be one of');
  });
});
