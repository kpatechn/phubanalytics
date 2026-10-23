// The CDP endpoints' queries against the real GEM dev database (schema cdp), compared
// with direct counts. Run: npm run test:integration -w @phub/api (needs GEM_DATABASE_URL).
import { afterAll, describe, expect, it } from 'vitest';
import { createCdpRepo } from '../src/cdp.js';
import { createSql } from '../src/db.js';

const url = process.env['GEM_DATABASE_URL'];

describe.skipIf(!url)('CDP queries on GEM dev', () => {
  const sql = createSql({ DATABASE_URL: url ?? '', DATABASE_SSL: process.env['GEM_DATABASE_SSL'] === 'disable' ? 'disable' : 'require' });
  const repo = createCdpRepo(sql, 'Chickasaw');

  afterAll(() => sql.end({ timeout: 5 }));

  it('meta names the window and the mock feeds', async () => {
    const meta = await repo.meta();
    expect(meta?.asOfDate).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(meta?.feeds.some((f) => f.isMock)).toBe(true);
    expect(meta?.feeds.some((f) => !f.isMock)).toBe(true);
  });

  it('segments match the profile and membership tables', async () => {
    const { totals, channels, segments } = await repo.segments();
    const [direct] = await sql`SELECT count(*) AS players, count(*) FILTER (WHERE is_marketable) AS marketable FROM cdp.player_profile`;
    expect(totals.players).toBe(direct!['players']);
    expect(totals.marketable).toBe(direct!['marketable']);
    expect(channels.map((c) => c.channel)).toEqual(['email', 'sms', 'push', 'mail']);
    for (const c of channels) expect(c.reachable + c.selfExcluded + c.noContact + c.optedOut + c.noConsent).toBe(totals.players);
    const [members] = await sql`SELECT count(*) AS n FROM cdp.segment_member`;
    expect(segments.reduce((n, s) => n + s.members, 0)).toBe(members!['n']);
    for (const s of segments) expect(s.marketable).toBeLessThanOrEqual(s.members);
  });

  it('site totals add up to the player-site summary', async () => {
    const { sites, crossVisits } = await repo.sites();
    const [direct] = await sql`SELECT sum(theo) AS theo, count(*) AS rows FROM cdp.player_site_summary`;
    expect(sites.reduce((n, s) => n + s.theo, 0)).toBeCloseTo(direct!['theo'], 2);
    expect(sites.reduce((n, s) => n + s.activePlayers, 0)).toBe(direct!['rows']);
    expect(sites.find((s) => s.siteCode === 'WINSTAR')?.gamingIsMock).toBe(false);
    expect(crossVisits.every((c) => c.homeSite !== c.visitedSite)).toBe(true);
  });

  it('a champion looks up with matching profile, sites and segments', async () => {
    const [example] = (await repo.examples('champions')) ?? [];
    expect(example).toBeDefined();
    const player = await repo.player(example!.accountNumber);
    expect(player?.profile.combinedValue).toBeCloseTo(example!.combinedValue, 2);
    expect(player?.segments.map((s) => s.code)).toContain('champions');
    expect(player?.reach).toHaveLength(4);
    expect(player?.sites.reduce((n, s) => n + s.theo, 0)).toBeCloseTo(player!.profile.theo, 2);
    expect(player?.recent.length).toBeGreaterThan(0);
    expect(await repo.player('999999999999')).toBeNull();
    expect(await repo.examples('no_such_segment')).toBeNull();
  });

  it('a hosted player with loyalty figures and preferences carries them through', async () => {
    const [row] = await sql`
      SELECT p.account_number::text AS account, p.host_rep_code, p.tier_points, p.points_to_next_tier, p.next_tier_name,
             pr.top_game, pr.favorite_weekday, l.lifetime_trips
      FROM cdp.player_profile p
      JOIN cdp.player_loyalty l USING (account_number)
      JOIN cdp.player_preference pr USING (account_number)
      WHERE p.host_rep_code IS NOT NULL AND pr.top_game IS NOT NULL AND l.tier_points IS NOT NULL
      ORDER BY p.account_number LIMIT 1`;
    expect(row).toBeDefined();
    const player = await repo.player(row!['account']);
    expect(player?.hosts[0]?.repCode).toBe(row!['host_rep_code']);
    expect(player?.loyalty?.tierPoints).toBe(row!['tier_points']);
    expect(player?.loyalty?.pointsToNextTier).toBe(row!['points_to_next_tier']);
    expect(player?.loyalty?.nextTier).toBe(row!['next_tier_name']);
    expect(player?.loyalty?.lifetimeTrips).toBe(row!['lifetime_trips']);
    expect(player?.preferences?.topGame).toBe(row!['top_game']);
    expect(player?.preferences?.favoriteWeekday).toBe(row!['favorite_weekday']);
  });
});
