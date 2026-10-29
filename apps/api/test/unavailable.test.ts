import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RxMeta } from '@phub/contracts';
import { buildApp } from '../src/app.js';
import { devAuthenticator } from '../src/auth.js';
import type { CdpRepo } from '../src/cdp.js';
import type { RxRepo } from '../src/reinvestment.js';
import type { AnalyticsRepo } from '../src/repo.js';
import { unavailable } from '../src/unavailable.js';

// When a data source can't be reached the screen should say which one and what usually fixes it,
// not "Internal Server Error". Real bugs stay 500s.

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
const named = (name: string) => Object.assign(new Error(name), { name });

describe('unavailable data sources', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const meta: RxMeta = { tenant: 'chickasaw_sim', dataKind: 'mock', asOfMonth: null, ruleVersion: null, sites: [], optimizerEnabled: false };

  beforeAll(async () => {
    app = await buildApp({
      config: { AUTH_MODE: 'dev', ALLOWED_ORIGIN: undefined },
      authenticate: devAuthenticator(),
      // DNS fails for the analytics database (a VPN switching resolvers).
      repo: { properties: async () => Promise.reject(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND db.internal.example')) } as unknown as AnalyticsRepo,
      // The CDP's database is VPN-only; postgres.js times out connecting.
      cdp: { meta: async () => Promise.reject(coded('CONNECT_TIMEOUT')) } as unknown as CdpRepo,
      reinvestment: {
        meta: async () => meta,
        // Local AWS session expired.
        overview: async () => Promise.reject(named('ExpiredTokenException')),
        // A real bug.
        runs: async () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'x')")),
      } as unknown as RxRepo,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('says the analytics database is unreachable, with a retry hint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/properties' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.json()).toMatchObject({ title: 'Database unreachable', status: 503 });
    expect(res.json().detail).toContain('analytics database');
    expect(res.body).not.toContain('db.internal.example');
  });

  it('points at the VPN for the CDP', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cdp/meta' });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toContain('VPN');
  });

  it('asks for a fresh AWS sign-in, without a retry timer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reinvestment/overview' });
    expect(res.statusCode).toBe(503);
    expect(res.json().title).toBe('AWS sign-in expired');
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('keeps real bugs as 500s and says nothing about them', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reinvestment/optimizer/runs' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ type: 'about:blank', title: 'Internal Server Error', status: 500 });
  });

  it('reads codes wrapped as a cause', () => {
    const wrapped = new Error('fetch failed', { cause: coded('ECONNRESET') });
    expect(unavailable(wrapped, '/api/reinvestment/overview')?.problem.detail).toContain('serving database');
    expect(unavailable(named('DatabaseResumingException'), '/api/reinvestment/overview')?.retryAfter).toBe(60);
    expect(unavailable(coded('23505'), '/api/analytics/executive')).toBeNull();
  });
});
