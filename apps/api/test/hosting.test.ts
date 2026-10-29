import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RxMeta } from '@phub/contracts';
import { buildApp } from '../src/app.js';
import { jwtAuthenticator } from '../src/auth.js';
import type { RxRepo } from '../src/reinvestment.js';

// Hosted behind the load balancer: Cognito signs people in, the load balancer passes the access
// token in x-amzn-oidc-accesstoken, and only the reinvestment screens are configured.

const ISSUER = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_test';
const CLIENT = 'dashboard-client';
const HEADER = 'x-amzn-oidc-accesstoken';

const meta: RxMeta = { tenant: 'chickasaw_sim', dataKind: 'mock', asOfMonth: '2026-10-01', ruleVersion: 'draft-1:draft', sites: [], optimizerEnabled: true };
const rx = {
  meta: async () => meta,
  overview: async () => ({ months: [], campaigns: [] }),
  runs: async () => [],
} as unknown as RxRepo;

describe('hosted behind the load balancer', () => {
  let token: (claims: Record<string, unknown>) => Promise<string>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
    token = (claims) =>
      new SignJWT({ token_use: 'access', client_id: CLIENT, username: 'kp', 'cognito:groups': ['analytics:marketing'], ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('6f1c2a7e-0000-4000-8000-000000000001')
        .setIssuer(ISSUER)
        .setExpirationTime('5m')
        .sign(privateKey);

    const web = mkdtempSync(join(tmpdir(), 'phub-web-'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>PlayerHub Analytics</title>');
    mkdirSync(join(web, 'media'));
    writeFileSync(join(web, 'main-AB12CD34.js'), 'console.log(1)');

    app = await buildApp({
      config: { AUTH_MODE: 'jwt', ALLOWED_ORIGIN: undefined },
      reinvestment: rx,
      webRoot: web,
      authenticate: jwtAuthenticator({ keys, issuer: ISSUER, rolesClaim: 'cognito:groups', tokenHeader: HEADER, clientId: CLIENT, subjectClaim: 'username' }),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/analytics/me', headers });

  it('reads the Cognito access token the load balancer passes, with groups as roles', async () => {
    const res = await me({ [HEADER]: await token({}) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subject: 'kp', roles: ['analytics:marketing'], views: ['reinvestment'] });
  });

  it('refuses tokens for another app client, a bearer header, or none', async () => {
    expect((await me({ [HEADER]: await token({ client_id: 'someone-else' }) })).statusCode).toBe(401);
    expect((await me({ authorization: `Bearer ${await token({})}` })).statusCode).toBe(401);
    expect((await me({})).statusCode).toBe(401);
  });

  it('hides the views whose database is not configured', async () => {
    const headers = { [HEADER]: await token({ 'cognito:groups': ['analytics:admin'] }) };
    expect((await me(headers)).json().views).toEqual(['reinvestment']);
    expect((await app.inject({ method: 'GET', url: '/api/analytics/marketing', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/analytics/properties', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/reinvestment/overview', headers })).statusCode).toBe(200);
  });

  it('is ready without the analytics database', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the web app, its routes and hashed files, with the right caching', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).toBe('no-cache');
    const route = await app.inject({ method: 'GET', url: '/reinvestment/offers?x=1' });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('PlayerHub Analytics');
    expect(route.headers['x-frame-options']).toBe('DENY');
    const asset = await app.inject({ method: 'GET', url: '/main-AB12CD34.js' });
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('keeps unknown API paths and missing files as 404s', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/problem+json');
    expect((await app.inject({ method: 'GET', url: '/missing-file.js' })).statusCode).toBe(404);
  });
});
