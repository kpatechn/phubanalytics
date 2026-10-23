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
});
