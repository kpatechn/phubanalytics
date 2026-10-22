import type {
  CampaignResult,
  Delivery,
  DeviceModel,
  ItData,
  JobHealth,
  PlatformUsage,
  SessionLength,
  TierUsage,
  VersionUsage,
} from '@phub/contracts';
import type { Sql } from './db.js';
import type { Scope } from './repo.js';

// Queries over the platform rollups built from database dextrans (migration 003):
// sessionDaily, guestDeviceDaily, eventVersionDaily, pushDeliveryDaily,
// campaign/campaignDaily, accountTier, jobRunDaily/jobLatest.

const LENGTH_BUCKETS = [
  { column: 'lengthUnder30s', label: 'Under 30 s' },
  { column: 'length30sTo1m', label: '30 s – 1 min' },
  { column: 'length1To5m', label: '1 – 5 min' },
  { column: 'length5To15m', label: '5 – 15 min' },
  { column: 'length15To60m', label: '15 – 60 min' },
  { column: 'lengthOver60m', label: 'Over 60 min' },
] as const;

/** Numeric-aware version order: 1.10.0 > 1.9.2; "unknown" sorts lowest. */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'unknown') return -1;
  if (b === 'unknown') return 1;
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const diff = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (diff !== 0) return diff;
  }
  return 0;
}

export function platformQueries(sql: Sql) {
  const inScope = (s: Scope, alias: string) =>
    sql`${sql(alias)}."tenantId" = ${s.tenantId} AND ${sql(alias)}."propertyId" = ${s.propertyId}
        AND ${sql(alias)}."bucketDate" BETWEEN ${s.from}::date AND ${s.to}::date`;

  async function platforms(s: Scope): Promise<PlatformUsage[]> {
    const rows = await sql<PlatformUsage[]>`
      SELECT g.platform, sum(g.sessions) AS sessions, count(DISTINCT g."userId") AS accounts, count(DISTINCT g."deviceId") AS devices
        FROM analytics."guestDeviceDaily" g
       WHERE ${inScope(s, 'g')}
       GROUP BY g.platform
       ORDER BY accounts DESC, g.platform`;
    return rows.map((r) => ({ ...r }));
  }

  async function versions(s: Scope): Promise<VersionUsage[]> {
    const rows = await sql<Omit<VersionUsage, 'isLatest'>[]>`
      WITH sess AS (
        SELECT platform, "appVersion", sum(sessions) AS sessions FROM analytics."sessionDaily" d
         WHERE ${inScope(s, 'd')} GROUP BY 1, 2),
      acct AS (
        SELECT platform, "appVersion", count(DISTINCT "userId") AS accounts FROM analytics."guestDeviceDaily" g
         WHERE ${inScope(s, 'g')} GROUP BY 1, 2),
      ev AS (
        SELECT platform, "appVersion", sum("eventCount") AS events, sum("errorCount") AS errors FROM analytics."eventVersionDaily" e
         WHERE ${inScope(s, 'e')} GROUP BY 1, 2)
      SELECT platform, "appVersion",
             coalesce(sess.sessions, 0) AS sessions, coalesce(acct.accounts, 0) AS accounts,
             coalesce(ev.events, 0) AS events, coalesce(ev.errors, 0) AS errors
        FROM sess FULL JOIN acct USING (platform, "appVersion") FULL JOIN ev USING (platform, "appVersion")`;
    const latest = new Map<string, string>();
    for (const r of rows) {
      if (r.appVersion === 'unknown') continue;
      const current = latest.get(r.platform);
      if (!current || compareVersions(r.appVersion, current) > 0) latest.set(r.platform, r.appVersion);
    }
    return rows
      .map((r) => ({ ...r, isLatest: latest.get(r.platform) === r.appVersion }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || compareVersions(b.appVersion, a.appVersion));
  }

  async function sessionLength(s: Scope): Promise<SessionLength[]> {
    const rows = await sql<Record<string, string | number>[]>`
      SELECT platform, sum(sessions) AS sessions, sum("endedSessions") AS ended, sum("durationSeconds") AS seconds,
             ${sql.unsafe(LENGTH_BUCKETS.map((b) => `sum("${b.column}") AS "${b.column}"`).join(', '))}
        FROM analytics."sessionDaily" d
       WHERE ${inScope(s, 'd')}
       GROUP BY platform
       ORDER BY platform`;
    return rows.map((r) => {
      const ended = Number(r['ended']);
      const buckets = LENGTH_BUCKETS.map((b) => ({ label: b.label, sessions: Number(r[b.column]) }));
      let running = 0;
      const median = buckets.find((b) => (running += b.sessions) >= ended / 2 && ended > 0);
      return {
        platform: String(r['platform']),
        sessions: Number(r['sessions']),
        ended,
        avgSeconds: ended > 0 ? Math.round((Number(r['seconds']) / ended) * 10) / 10 : null,
        medianBucket: median?.label ?? null,
        buckets,
      };
    });
  }

  async function deviceModels(s: Scope): Promise<DeviceModel[]> {
    const rows = await sql<DeviceModel[]>`
      SELECT g.platform, g.model, count(DISTINCT g."deviceId") AS devices, count(DISTINCT g."userId") AS accounts
        FROM analytics."guestDeviceDaily" g
       WHERE ${inScope(s, 'g')}
       GROUP BY 1, 2
       ORDER BY devices DESC, accounts DESC, g.model
       LIMIT 15`;
    return rows.map((r) => ({ ...r }));
  }

  async function delivery(s: Scope): Promise<Delivery> {
    const [byType, reasons, daily] = await Promise.all([
      sql<Delivery['byType']>`
        SELECT "messageType",
               sum(sends) AS sent,
               coalesce(sum(sends) FILTER (WHERE status = 'delivered'), 0) AS delivered,
               coalesce(sum(sends) FILTER (WHERE status = 'failed'), 0) AS failed,
               coalesce(sum(sends) FILTER (WHERE status NOT IN ('delivered', 'failed')), 0) AS other
          FROM analytics."pushDeliveryDaily" d
         WHERE ${inScope(s, 'd')}
         GROUP BY 1
         ORDER BY sent DESC, 1`,
      sql<Delivery['reasons']>`
        SELECT reason, sum(sends) AS count
          FROM analytics."pushDeliveryDaily" d
         WHERE ${inScope(s, 'd')} AND status = 'failed'
         GROUP BY 1
         ORDER BY count DESC, reason
         LIMIT 10`,
      sql<Delivery['daily']>`
        SELECT c.day::date::text AS day,
               coalesce(sum(d.sends) FILTER (WHERE d.status = 'delivered'), 0) AS delivered,
               coalesce(sum(d.sends) FILTER (WHERE d.status = 'failed'), 0) AS failed,
               coalesce(sum(d.sends) FILTER (WHERE d.status NOT IN ('delivered', 'failed')), 0) AS other
          FROM generate_series(${s.from}::date, ${s.to}::date, interval '1 day') AS c(day)
          LEFT JOIN analytics."pushDeliveryDaily" d
            ON d."bucketDate" = c.day::date AND d."tenantId" = ${s.tenantId} AND d."propertyId" = ${s.propertyId}
         GROUP BY c.day
         ORDER BY c.day`,
    ]);
    return { byType: byType.map((r) => ({ ...r })), reasons: reasons.map((r) => ({ ...r })), daily: daily.map((r) => ({ ...r })) };
  }

  async function campaignResults(s: Scope): Promise<CampaignResult[]> {
    const rows = await sql<CampaignResult[]>`
      SELECT d."campaignId"::text AS "campaignId",
             coalesce(c.name, '(not in campaign list)') AS name, coalesce(c.category, '') AS category,
             coalesce(c.status, '') AS status, coalesce(c."targetType", '') AS "targetType",
             coalesce(c."isTest", false) AS "isTest", d.channel,
             sum(d.sent) AS sent, sum(d.delivered) AS delivered, sum(d.opened) AS opened,
             sum(d.clicked) AS clicked, sum(d.converted) AS converted, sum(d.unsubscribed) AS unsubscribed
        FROM analytics."campaignDaily" d
        LEFT JOIN analytics.campaign c
          ON c."tenantId" = d."tenantId" AND c."propertyId" = d."propertyId" AND c."campaignId" = d."campaignId"
       WHERE ${inScope(s, 'd')}
       GROUP BY 1, 2, 3, 4, 5, 6, 7
       ORDER BY sent DESC, name`;
    return rows.map((r) => ({ ...r }));
  }

  async function jobs(s: Scope): Promise<{ jobs: JobHealth[]; daily: ItData['jobDaily'] }> {
    const [rows, daily] = await Promise.all([
      sql<JobHealth[]>`
        WITH r AS (
          SELECT "jobName", sum(runs) AS runs, sum(completed) AS completed, sum(failed) AS failed, sum(stuck) AS stuck,
                 sum(running) AS running, sum("durationSeconds") AS seconds, sum("durationCount") AS timed,
                 max("maxDurationSeconds") AS "maxSeconds"
            FROM analytics."jobRunDaily" j
           WHERE ${inScope(s, 'j')}
           GROUP BY 1)
        SELECT coalesce(r."jobName", l."jobName") AS "jobName",
               coalesce(l."isTest", analytics."looksLikeTest"(r."jobName")) AS "isTest",
               coalesce(r.runs, 0) AS runs, coalesce(r.completed, 0) AS completed, coalesce(r.failed, 0) AS failed,
               coalesce(r.stuck, 0) AS stuck, coalesce(r.running, 0) AS running,
               CASE WHEN r.timed > 0 THEN round(r.seconds / r.timed, 1) END AS "avgSeconds",
               round(r."maxSeconds", 1) AS "maxSeconds",
               l."lastStartAt", l."lastStatus"
          FROM r
          FULL JOIN (SELECT * FROM analytics."jobLatest" WHERE "tenantId" = ${s.tenantId} AND "propertyId" = ${s.propertyId}) l
            ON l."jobName" = r."jobName"
         ORDER BY runs DESC, "jobName"`,
      sql<ItData['jobDaily']>`
        SELECT c.day::date::text AS day, coalesce(sum(j.runs), 0) AS runs, coalesce(sum(j.failed), 0) AS failed, coalesce(sum(j.stuck), 0) AS stuck
          FROM generate_series(${s.from}::date, ${s.to}::date, interval '1 day') AS c(day)
          LEFT JOIN analytics."jobRunDaily" j
            ON j."bucketDate" = c.day::date AND j."tenantId" = ${s.tenantId} AND j."propertyId" = ${s.propertyId}
         GROUP BY c.day
         ORDER BY c.day`,
    ]);
    // lastStartAt arrives as a Date and serializes as an ISO string.
    return { jobs: rows.map((r) => ({ ...r })), daily: daily.map((r) => ({ ...r })) };
  }

  /** Active accounts by current tier. New = first active day ever falls in the period. */
  async function tiers(s: Scope): Promise<TierUsage[]> {
    const rows = await sql<TierUsage[]>`
      WITH firsts AS (
        SELECT g."userId" AS u, min(g."bucketDate") AS f
          FROM analytics."guestDaily" g
         WHERE g."tenantId" = ${s.tenantId} AND g."propertyId" = ${s.propertyId} AND g."foregroundEventCount" > 0
           AND g."bucketDate" <= ${s.to}::date
         GROUP BY g."userId"),
      active AS (
        SELECT g."userId", bool_or(g."onsiteForegroundEventCount" > 0) AS onsite
          FROM analytics."guestDaily" g
         WHERE ${inScope(s, 'g')} AND g."foregroundEventCount" > 0
         GROUP BY g."userId")
      SELECT coalesce(t.tier, '(no card)') AS tier,
             count(*) AS "activeAccounts",
             count(*) FILTER (WHERE a.onsite) AS "onsiteAccounts",
             count(*) FILTER (WHERE f.f >= ${s.from}::date) AS "newAccounts"
        FROM active a
        JOIN firsts f ON f.u = a."userId"
        LEFT JOIN analytics."accountTier" t
          ON t."tenantId" = ${s.tenantId} AND t."propertyId" = ${s.propertyId} AND t."userId" = a."userId"
       GROUP BY 1
       ORDER BY "activeAccounts" DESC, tier`;
    return rows.map((r) => ({ ...r }));
  }

  async function featureTiers(s: Scope): Promise<{ feature: string; tier: string; accounts: number }[]> {
    const rows = await sql<{ feature: string; tier: string; accounts: number }[]>`
      SELECT c.feature, coalesce(t.tier, '(no card)') AS tier, count(DISTINCT g."userId") AS accounts
        FROM analytics."guestEventDaily" g
        JOIN analytics."eventCatalog" c ON c."eventId" = g."eventId" AND c.feature IS NOT NULL AND c."isActive"
        LEFT JOIN analytics."accountTier" t
          ON t."tenantId" = g."tenantId" AND t."propertyId" = g."propertyId" AND t."userId" = g."userId"
       WHERE ${inScope(s, 'g')}
       GROUP BY 1, 2
       ORDER BY 1, 2`;
    return rows.map((r) => ({ ...r }));
  }

  return { platforms, versions, sessionLength, deviceModels, delivery, campaignResults, jobs, tiers, featureTiers };
}
