// Plan section 4 golden values, read through the API's queries from a real
// database (Graton dev). Run: npm run test:integration -w @phub/api
import { afterAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/dates.js';
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

  it('engagement matches an independent count from raw events', async () => {
    const e = await repo.engagement(scope, previous, '2026-10-22');

    // Accounts with a foreground event per Pacific day, straight from raw events.
    const raw = await sql<{ day: string; u: string }[]>`
      SELECT DISTINCT (r."createdDate" AT TIME ZONE 'America/Los_Angeles')::date::text AS day, r."userId" AS u
        FROM data."dexAnalytics" r
        JOIN analytics."eventCatalog" c ON c."eventId" = r."eventId" AND c."isForeground"
       WHERE r."tenantId" = 15001 AND r."propertyId" = 1500001 AND nullif(btrim(r."userId"), '') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM analytics."excludedUser" x WHERE x."userId" = r."userId")`;
    const byDay = new Map<string, Set<string>>();
    const first = new Map<string, string>();
    for (const { day, u } of raw) {
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day)!.add(u);
      if (!first.has(u) || day < first.get(u)!) first.set(u, day);
    }
    const distinct = (from: string, to: string) => {
      const set = new Set<string>();
      for (const [day, users] of byDay) if (day >= from && day <= to) users.forEach((u) => set.add(u));
      return set.size;
    };
    const firstOn = (from: string, to: string) => [...first.values()].filter((f) => f >= from && f <= to).length;

    expect(e.daily).toHaveLength(30);
    for (const p of e.daily) {
      expect({ day: p.day, dau: p.dau, wau: p.wau, mau: p.mau, newAccounts: p.newAccounts }).toEqual({
        day: p.day,
        dau: byDay.get(p.day)?.size ?? 0,
        wau: distinct(addDays(p.day, -6), p.day),
        mau: distinct(addDays(p.day, -29), p.day),
        newAccounts: firstOn(p.day, p.day),
      });
    }
    expect(e.summary.activeAccounts).toBe(distinct(scope.from, scope.to));
    expect(e.summary.newAccounts).toBe(firstOn(scope.from, scope.to));
    expect(e.summary.mau).toBe(distinct(addDays(scope.to, -29), scope.to));
    expect(e.summary.returningAccounts).toBe(e.summary.activeAccounts - e.summary.newAccounts);
    for (const c of e.cohorts) expect(c.weeks[0]?.accounts).toBe(c.size);
    expect(e.backgroundEvents).toContain('geofence_entered');
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
