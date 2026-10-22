// Plan section 4 golden values, read through the API's queries from a real
// database (Graton dev). Run: npm run test:integration -w @phub/api
import { afterAll, describe, expect, it } from 'vitest';
import { createSql } from '../src/db.js';
import { createRepo } from '../src/repo.js';

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('golden values from Graton dev rollups', () => {
  const sql = createSql({ DATABASE_URL: url ?? '', DATABASE_SSL: process.env['DATABASE_SSL'] === 'disable' ? 'disable' : 'require' });
  const repo = createRepo(sql);
  const scope = { tenantId: 15001, propertyId: 1500001, from: '2026-09-03', to: '2026-10-02' };
  const previous = { ...scope, from: '2026-08-04', to: '2026-09-02' };

  afterAll(() => sql.end({ timeout: 5 }));

  it('executive', async () => {
    const { kpis, daily, features } = await repo.executive(scope, previous);
    expect(kpis).toMatchObject({
      totalEvents: 3494,
      sessions: 186,
      appOpens: 230,
      loginStarted: 58,
      loginSuccess: 55,
      playersLoggedIn: 8, // by account; the plan's 13 counted mixed player_id values
      onsiteEvents: 1877,
      apiErrors: 438,
    });
    expect(daily).toHaveLength(30);
    expect(daily.reduce((n, d) => n + d.events, 0)).toBe(3494);
    expect(features.find((f) => f.feature === 'Wallet')).toMatchObject({ onsite: 23, offsite: 53 });
    expect(features.find((f) => f.feature === 'Card linking')).toMatchObject({ onsite: 9, offsite: 26 });
  });

  it('marketing', async () => {
    const m = await repo.marketing(scope);
    expect(m.funnel).toMatchObject({ inboxViewed: 84, opened: 38, markedRead: 38, deleted: 76, ctaCompleted: 0, pushOpened: 16, pushReceived: 20 });
    expect(m.campaigns).toEqual([{ campaignId: 'unknown_campaign', opens: 16 }]);
    expect(m.permissions).toMatchObject({ granted: 204, denied: 20 });
    expect(Object.fromEntries(m.permissions.denialTypes.map((d) => [d.type, d.count]))).toEqual({ skipped: 18, permanently_denied: 2 });
    expect(m.geofences.reduce((n, g) => n + g.entries, 0)).toBe(327);
    expect(m.geofenceExits).toBe(9);
    expect(m.webContent.find((w) => w.page === 'Gift & Go')?.avgSeconds).toBe(0.5);
  });

  it('it', async () => {
    const t = await repo.it(scope);
    const byEndpoint = (needle: string) => t.errors.filter((e) => e.endpoint.includes(needle)).reduce((n, e) => n + e.count, 0);
    expect(byEndpoint('analyticLogs')).toBe(227);
    expect(byEndpoint('points')).toBe(159);
    expect(t.biometrics).toEqual({ passed: 21, failed: 2 });
    expect(t.logins).toMatchObject({ started: 58, succeeded: 55 });
    expect(t.hourly).toHaveLength(24);
    expect(t.hourly.reduce((n, h) => n + h.events, 0)).toBe(3494);
  });
});
