import type {
  DailyPoint,
  EngagementData,
  EngagementPoint,
  EngagementSummary,
  ExecutiveData,
  ExecutiveKpis,
  FeatureUsage,
  ItData,
  MarketingData,
  Property,
  RetentionCohort,
  ReturnRate,
} from '@phub/contracts';
import type { Sql } from './db.js';
import { platformQueries } from './platform.js';

// Every query reads the analytics rollups (database dexl, schema analytics),
// never raw events. Days are property-local bucketDate values, inclusive.

export interface Scope {
  tenantId: number;
  propertyId: number;
  from: string;
  to: string;
}

export interface Freshness {
  latestEventAt: Date | null;
  lastSuccessAt: Date | null;
  queuedHours: number;
  oldestQueuedAt: Date | null;
  dextransRefreshedAt: Date | null;
}

export interface AnalyticsRepo {
  ping(): Promise<void>;
  properties(): Promise<Property[]>;
  freshness(property: Property): Promise<Freshness>;
  executive(scope: Scope, previous: Scope): Promise<ExecutiveData>;
  /** asOf: today in the property's time zone; only days before it count as complete. */
  engagement(scope: Scope, previous: Scope, asOf: string): Promise<EngagementData>;
  marketing(scope: Scope): Promise<MarketingData>;
  it(scope: Scope): Promise<ItData>;
}

interface PeriodCounts {
  activeAccounts: number;
  newAccounts: number;
  onsiteAccounts: number;
}

/** Weeks of retention shown per cohort, after the cohort week itself. */
const RETENTION_WEEKS = 8;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

function summarize(points: EngagementPoint[], counts: PeriodCounts): EngagementSummary {
  const avg = (pick: (p: EngagementPoint) => number) => (points.length ? points.reduce((n, p) => n + pick(p), 0) / points.length : 0);
  const withMau = points.filter((p) => p.mau > 0);
  const ratio = (pick: (p: EngagementPoint) => number) =>
    withMau.length ? round(withMau.reduce((n, p) => n + pick(p) / p.mau, 0) / withMau.length, 4) : null;
  return {
    dau: round(avg((p) => p.dau), 1),
    wau: round(avg((p) => p.wau), 1),
    mau: points.at(-1)?.mau ?? 0,
    dauMau: ratio((p) => p.dau),
    wauMau: ratio((p) => p.wau),
    activeAccounts: counts.activeAccounts,
    newAccounts: counts.newAccounts,
    returningAccounts: counts.activeAccounts - counts.newAccounts,
    onsiteAccounts: counts.onsiteAccounts,
  };
}

/** Days between two YYYY-MM-DD dates. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

interface DimensionRow {
  value: string;
  count: number;
  avgSeconds: number | null;
}

export function createRepo(sql: Sql): AnalyticsRepo {
  const platform = platformQueries(sql);
  const inScope = (s: Scope, alias: string) =>
    sql`${sql(alias)}."tenantId" = ${s.tenantId} AND ${sql(alias)}."propertyId" = ${s.propertyId}
        AND ${sql(alias)}."bucketDate" BETWEEN ${s.from}::date AND ${s.to}::date`;

  async function kpis(s: Scope): Promise<ExecutiveKpis> {
    const [row] = await sql<ExecutiveKpis[]>`
      SELECT
        coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'session_started'), 0) AS sessions,
        coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'app_opened'), 0)      AS "appOpens",
        coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'login_initiated'), 0) AS "loginStarted",
        coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'login_completed'), 0) AS "loginSuccess",
        coalesce(sum(e."eventCount") FILTER (WHERE e."locationContext" = 'onsite'), 0)  AS "onsiteEvents",
        coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'api_error'), 0)       AS "apiErrors",
        coalesce(sum(e."eventCount"), 0)                                                AS "totalEvents",
        (SELECT count(DISTINCT g."userId") FROM analytics."guestEventDaily" g
          WHERE ${inScope(s, 'g')} AND g."eventId" = 'login_completed')                 AS "playersLoggedIn",
        (SELECT count(DISTINCT g."userId") FROM analytics."guestDaily" g
          WHERE ${inScope(s, 'g')})                                                     AS "activeGuests"
      FROM analytics."eventDaily" e
      WHERE ${inScope(s, 'e')}`;
    return { ...row! };
  }

  async function daily(s: Scope): Promise<DailyPoint[]> {
    const rows = await sql<DailyPoint[]>`
      SELECT d.day::date::text AS day,
             coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'session_started'), 0) AS sessions,
             coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'login_completed'), 0) AS logins,
             coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'api_error'), 0)       AS errors,
             coalesce(sum(e."eventCount"), 0)                                                AS events
        FROM generate_series(${s.from}::date, ${s.to}::date, interval '1 day') AS d(day)
        LEFT JOIN analytics."eventDaily" e
          ON e."bucketDate" = d.day::date AND e."tenantId" = ${s.tenantId} AND e."propertyId" = ${s.propertyId}
       GROUP BY d.day
       ORDER BY d.day`;
    return rows.map((r) => ({ ...r }));
  }

  /** Event counts for several events in one pass. */
  async function counts<K extends string>(s: Scope, events: Record<K, string>): Promise<Record<K, number>> {
    const ids = [...new Set(Object.values<string>(events))];
    const rows = await sql<{ eventId: string; count: number }[]>`
      SELECT e."eventId", sum(e."eventCount") AS count
        FROM analytics."eventDaily" e
       WHERE ${inScope(s, 'e')} AND e."eventId" IN ${sql(ids)}
       GROUP BY e."eventId"`;
    const byEvent = new Map(rows.map((r) => [r.eventId, r.count]));
    const out = {} as Record<K, number>;
    for (const key of Object.keys(events) as K[]) out[key] = byEvent.get(events[key]) ?? 0;
    return out;
  }

  /**
   * One dimensionRule breakdown, largest first. avgSeconds assumes the numeric key is milliseconds.
   * Some app builds send the event's own ID as its label; that counts as no label.
   */
  async function dimension(s: Scope, eventIds: string[], dimensionType: string, limit: number | null): Promise<DimensionRow[]> {
    const rows = await sql<DimensionRow[]>`
      SELECT CASE WHEN x."dimensionValue" = x."eventId" THEN '(none)' ELSE x."dimensionValue" END AS value,
             sum(x."eventCount") AS count,
             CASE WHEN sum(x."numericValueCount") > 0
                  THEN round(sum(x."numericValueSum") / sum(x."numericValueCount") / 1000, 1) END AS "avgSeconds"
        FROM analytics."eventDimensionDaily" x
       WHERE ${inScope(s, 'x')} AND x."eventId" IN ${sql(eventIds)} AND x."dimensionType" = ${dimensionType}
       GROUP BY 1
       ORDER BY count DESC, value
       LIMIT ${limit}`;
    return rows.map((r) => ({ ...r }));
  }

  // Engagement: an account is active on a day when guestDaily."foregroundEventCount" > 0.

  /** First active day of every account, over all history up to `until`. */
  const firstActive = (t: number, p: number, until: string) => sql`
    SELECT g."userId" AS u, min(g."bucketDate") AS f
      FROM analytics."guestDaily" g
     WHERE g."tenantId" = ${t} AND g."propertyId" = ${p} AND g."foregroundEventCount" > 0
       AND g."bucketDate" <= ${until}::date
     GROUP BY g."userId"`;

  /**
   * Daily DAU, trailing WAU (7 days) and MAU (30 days), on-property and new accounts.
   * Rolling distinct counts: each active day covers the next n days; overlapping
   * coverage per account is merged with lag(), then +1/-1 edges are summed in day order.
   */
  async function engagementSeries(s: Scope): Promise<EngagementPoint[]> {
    const rows = await sql<EngagementPoint[]>`
      WITH a AS (
        SELECT g."userId" AS u, g."bucketDate" AS d, g."onsiteForegroundEventCount" > 0 AS onsite
          FROM analytics."guestDaily" g
         WHERE g."tenantId" = ${s.tenantId} AND g."propertyId" = ${s.propertyId} AND g."foregroundEventCount" > 0
           AND g."bucketDate" BETWEEN ${s.from}::date - 29 AND ${s.to}::date
      ),
      firsts AS (${firstActive(s.tenantId, s.propertyId, s.to)}),
      seg AS (
        SELECT w.n, a.d, lag(a.d) OVER (PARTITION BY w.n, a.u ORDER BY a.d) AS prev
          FROM a CROSS JOIN (VALUES (7), (30)) AS w(n)
      ),
      edges AS (
        SELECT n, greatest(d, coalesce(prev + n, d)) AS day, 1 AS delta FROM seg
        UNION ALL
        SELECT n, d + n, -1 FROM seg
      ),
      running AS (
        SELECT n, day, sum(sum(delta)) OVER (PARTITION BY n ORDER BY day) AS active
          FROM edges GROUP BY n, day
      ),
      daily AS (
        SELECT a.d, count(*) AS dau, count(*) FILTER (WHERE a.onsite) AS onsite, count(*) FILTER (WHERE f.f = a.d) AS new
          FROM a JOIN firsts f ON f.u = a.u
         GROUP BY a.d
      )
      SELECT c.day::date::text AS day,
             coalesce(daily.dau, 0) AS dau,
             coalesce((SELECT r.active FROM running r WHERE r.n = 7 AND r.day <= c.day::date ORDER BY r.day DESC LIMIT 1), 0) AS wau,
             coalesce((SELECT r.active FROM running r WHERE r.n = 30 AND r.day <= c.day::date ORDER BY r.day DESC LIMIT 1), 0) AS mau,
             coalesce(daily.onsite, 0) AS onsite,
             coalesce(daily.new, 0) AS "newAccounts",
             coalesce(daily.dau - daily.new, 0) AS "returningAccounts"
        FROM generate_series(${s.from}::date, ${s.to}::date, interval '1 day') AS c(day)
        LEFT JOIN daily ON daily.d = c.day::date
       ORDER BY c.day`;
    return rows.map((r) => ({ ...r }));
  }

  async function periodCounts(s: Scope): Promise<PeriodCounts> {
    const [row] = await sql<PeriodCounts[]>`
      WITH firsts AS (${firstActive(s.tenantId, s.propertyId, s.to)}),
      p AS (
        SELECT g."userId" AS u, bool_or(g."onsiteForegroundEventCount" > 0) AS onsite
          FROM analytics."guestDaily" g
         WHERE ${inScope(s, 'g')} AND g."foregroundEventCount" > 0
         GROUP BY g."userId"
      )
      SELECT count(*) AS "activeAccounts",
             count(*) FILTER (WHERE f.f >= ${s.from}::date) AS "newAccounts",
             count(*) FILTER (WHERE p.onsite) AS "onsiteAccounts"
        FROM p JOIN firsts f ON f.u = p.u`;
    return { ...row! };
  }

  /** New accounts in the period that came back within 7 and 30 days, where that window has fully passed. */
  async function returnRates(s: Scope, asOf: string): Promise<ReturnRate[]> {
    const rows = await sql<ReturnRate[]>`
      WITH firsts AS (${firstActive(s.tenantId, s.propertyId, s.to)})
      SELECT n.days,
             count(*) FILTER (WHERE f.f + n.days < ${asOf}::date) AS eligible,
             count(*) FILTER (WHERE f.f + n.days < ${asOf}::date AND EXISTS (
               SELECT 1 FROM analytics."guestDaily" g
                WHERE g."tenantId" = ${s.tenantId} AND g."propertyId" = ${s.propertyId} AND g."userId" = f.u
                  AND g."foregroundEventCount" > 0 AND g."bucketDate" BETWEEN f.f + 1 AND f.f + n.days)) AS returned
        FROM (VALUES (7), (30)) AS n(days)
        LEFT JOIN firsts f ON f.f BETWEEN ${s.from}::date AND ${s.to}::date
       GROUP BY n.days
       ORDER BY n.days`;
    return rows.map((r) => ({ ...r }));
  }

  /** Weekly cohorts (Monday weeks) first active in the period, and their activity in later weeks. */
  async function cohorts(s: Scope, asOf: string): Promise<RetentionCohort[]> {
    const rows = await sql<{ weekStart: string; week: number; accounts: number }[]>`
      WITH firsts AS (${firstActive(s.tenantId, s.propertyId, asOf)}),
      c AS (
        SELECT u, date_trunc('week', f::timestamp)::date AS wk FROM firsts
         WHERE date_trunc('week', f::timestamp)::date BETWEEN date_trunc('week', ${s.from}::date::timestamp)::date AND ${s.to}::date
      ),
      act AS (
        SELECT DISTINCT g."userId" AS u, date_trunc('week', g."bucketDate"::timestamp)::date AS wk
          FROM analytics."guestDaily" g
         WHERE g."tenantId" = ${s.tenantId} AND g."propertyId" = ${s.propertyId} AND g."foregroundEventCount" > 0
           AND g."bucketDate" >= date_trunc('week', ${s.from}::date::timestamp)::date AND g."bucketDate" <= ${asOf}::date
      )
      SELECT c.wk::text AS "weekStart", (act.wk - c.wk) / 7 AS week, count(*) AS accounts
        FROM c JOIN act ON act.u = c.u AND act.wk >= c.wk
       GROUP BY c.wk, act.wk
       ORDER BY c.wk, act.wk`;
    const byWeek = new Map<string, Map<number, number>>();
    for (const r of rows) {
      if (!byWeek.has(r.weekStart)) byWeek.set(r.weekStart, new Map());
      byWeek.get(r.weekStart)!.set(r.week, r.accounts);
    }
    return [...byWeek].map(([weekStart, weeks]) => {
      // Week n has started once weekStart + 7n <= asOf; it is complete once all 7 days are before asOf.
      const started = Math.min(RETENTION_WEEKS, Math.floor(daysBetween(weekStart, asOf) / 7));
      return {
        weekStart,
        size: weeks.get(0) ?? 0,
        weeks: Array.from({ length: Math.max(0, started) + 1 }, (_, week) => ({
          week,
          accounts: weeks.get(week) ?? 0,
          complete: daysBetween(weekStart, asOf) >= 7 * (week + 1),
        })),
      };
    });
  }

  return {
    async ping() {
      await sql`SELECT 1`;
    },

    async properties() {
      const rows = await sql<Property[]>`
        SELECT "tenantId", "propertyId", name, "timeZone", environment
          FROM analytics.property
         ORDER BY name, "propertyId"`;
      return rows.map((r) => ({ ...r }));
    },

    async freshness(p) {
      const [row] = await sql<Freshness[]>`
        SELECT "latestEventAt", "lastSuccessAt", "queuedHours", "oldestQueuedAt", "dextransRefreshedAt"
          FROM analytics."refreshStatus"
         WHERE "tenantId" = ${p.tenantId} AND "propertyId" = ${p.propertyId}`;
      return row ? { ...row } : { latestEventAt: null, lastSuccessAt: null, queuedHours: 0, oldestQueuedAt: null, dextransRefreshedAt: null };
    },

    async executive(s, previous) {
      const [current, prior, series, features] = await Promise.all([
        kpis(s),
        kpis(previous),
        daily(s),
        sql<FeatureUsage[]>`
          SELECT f.feature,
                 coalesce(sum(e."eventCount") FILTER (WHERE e."locationContext" = 'onsite'), 0)  AS onsite,
                 coalesce(sum(e."eventCount") FILTER (WHERE e."locationContext" = 'offsite'), 0) AS offsite,
                 coalesce(sum(e."eventCount") FILTER (WHERE e."locationContext" = 'unknown'), 0) AS unknown
            FROM (SELECT DISTINCT feature FROM analytics."eventCatalog" WHERE feature IS NOT NULL AND "isActive") f
            JOIN analytics."eventCatalog" c ON c.feature = f.feature AND c."isActive"
            LEFT JOIN analytics."eventDaily" e ON e."eventId" = c."eventId" AND ${inScope(s, 'e')}
           GROUP BY f.feature
           ORDER BY coalesce(sum(e."eventCount"), 0) DESC, f.feature`,
      ]);
      return { kpis: current, previous: prior, daily: series, features: features.map((r) => ({ ...r })) };
    },

    async engagement(s, previous, asOf) {
      const [series, prevSeries, counts, prevCounts, rates, features, cohortRows, background, history, tiers, featureTiers, platforms] = await Promise.all([
        engagementSeries(s),
        engagementSeries(previous),
        periodCounts(s),
        periodCounts(previous),
        returnRates(s, asOf),
        sql<{ feature: string; accounts: number }[]>`
          SELECT f.feature, count(DISTINCT g."userId") AS accounts
            FROM (SELECT DISTINCT feature FROM analytics."eventCatalog" WHERE feature IS NOT NULL AND "isActive") f
            JOIN analytics."eventCatalog" c ON c.feature = f.feature AND c."isActive"
            LEFT JOIN analytics."guestEventDaily" g ON g."eventId" = c."eventId" AND ${inScope(s, 'g')}
           GROUP BY f.feature
           ORDER BY accounts DESC, f.feature`,
        cohorts(s, asOf),
        sql<{ eventId: string }[]>`SELECT "eventId" FROM analytics."eventCatalog" WHERE NOT "isForeground" ORDER BY "eventId"`,
        sql<{ start: string | null }[]>`
          SELECT min("bucketDate")::text AS start FROM analytics."guestDaily"
           WHERE "tenantId" = ${s.tenantId} AND "propertyId" = ${s.propertyId}`,
        platform.tiers(s),
        platform.featureTiers(s),
        platform.platforms(s),
      ]);
      return {
        summary: summarize(series, counts),
        previous: summarize(prevSeries, prevCounts),
        daily: series,
        returnRates: rates,
        features: features.map((r) => ({ ...r })),
        cohorts: cohortRows,
        backgroundEvents: background.map((r) => r.eventId),
        historyStart: history[0]?.start ?? null,
        tiers,
        featureTiers,
        platforms,
      };
    },

    async marketing(s) {
      const [c, cta, campaigns, messages, denials, geofences, web, promotions, events, drawings, delivery, campaignResults] = await Promise.all([
        counts(s, {
          inboxViewed: 'notification_list_viewed',
          opened: 'notification_details_viewed',
          markedRead: 'notification_marked_read',
          deleted: 'notification_deleted',
          pushReceived: 'push_device_handled',
          pushOpened: 'push_opened',
          granted: 'notification_permission_granted',
          denied: 'notification_permission_denied',
          geofenceExits: 'geofence_exited',
        }),
        dimension(s, ['notification_details_viewed'], 'cta_completed', null),
        dimension(s, ['push_opened'], 'campaign', 20),
        dimension(s, ['notification_details_viewed'], 'message_title', 10),
        dimension(s, ['notification_permission_denied'], 'denial_type', null),
        sql<MarketingData['geofences']>`
          SELECT x."dimensionValue"                         AS "geofenceId",
                 coalesce(z."displayName", x."dimensionValue") AS zone,
                 coalesce(z."isTest", false)                AS "isTest",
                 coalesce(sum(x."eventCount") FILTER (WHERE x."eventId" = 'geofence_entered'), 0) AS entries,
                 coalesce(sum(x."eventCount") FILTER (WHERE x."eventId" = 'geofence_exited'), 0)  AS exits
            FROM analytics."eventDimensionDaily" x
            LEFT JOIN analytics."geofenceZone" z
              ON z."tenantId" = x."tenantId" AND z."propertyId" = x."propertyId" AND z."geofenceId" = x."dimensionValue"
           WHERE ${inScope(s, 'x')} AND x."dimensionType" = 'geofence'
           GROUP BY 1, 2, 3
           ORDER BY entries DESC, zone`,
        dimension(s, ['webview_viewed'], 'web_page', 15),
        dimension(s, ['promotion_details_viewed'], 'promotion', 10),
        dimension(s, ['event_details_viewed'], 'event', 10),
        dimension(s, ['live_drawing_viewed'], 'drawing', 10),
        platform.delivery(s),
        platform.campaignResults(s),
      ]);
      return {
        funnel: {
          inboxViewed: c.inboxViewed,
          opened: c.opened,
          markedRead: c.markedRead,
          ctaCompleted: cta.find((r) => r.value === 'true')?.count ?? 0,
          deleted: c.deleted,
          pushReceived: c.pushReceived,
          pushOpened: c.pushOpened,
        },
        campaigns: campaigns.map((r) => ({ campaignId: r.value, opens: r.count })),
        topMessages: messages.map((r) => ({ title: r.value, opens: r.count })),
        permissions: {
          granted: c.granted,
          denied: c.denied,
          denialTypes: denials.map((r) => ({ type: r.value, count: r.count })),
        },
        geofences: geofences.map((r) => ({ ...r })),
        geofenceExits: c.geofenceExits,
        webContent: web.map((r) => ({ page: r.value, opens: r.count, avgSeconds: r.avgSeconds })),
        contentViews: [
          ...promotions.map((r) => ({ kind: 'promotion' as const, label: r.value, views: r.count, avgSeconds: r.avgSeconds })),
          ...events.map((r) => ({ kind: 'event' as const, label: r.value, views: r.count, avgSeconds: r.avgSeconds })),
          ...drawings.map((r) => ({ kind: 'drawing' as const, label: r.value, views: r.count, avgSeconds: r.avgSeconds })),
        ],
        delivery,
        campaignResults,
      };
    },

    async it(s) {
      const [errors, messages, series, hourly, screens, c, authMethods, versions, sessionLength, platforms, deviceModels, delivery, jobs] = await Promise.all([
        sql<ItData['errors']>`
          SELECT endpoint, method, "statusCode", "errorType", sum("eventCount") AS count
            FROM analytics."apiErrorDaily" a
           WHERE ${inScope(s, 'a')}
           GROUP BY 1, 2, 3, 4
           ORDER BY count DESC, endpoint`,
        sql<ItData['topMessages']>`
          SELECT message, endpoint, "statusCode", sum("eventCount") AS count
            FROM analytics."apiErrorDaily" a
           WHERE ${inScope(s, 'a')}
           GROUP BY 1, 2, 3
           ORDER BY count DESC, message
           LIMIT 10`,
        daily(s),
        sql<ItData['hourly']>`
          SELECT h AS hour,
                 coalesce(sum(e."eventCount"), 0) AS events,
                 coalesce(sum(e."eventCount") FILTER (WHERE e."eventId" = 'api_error'), 0) AS errors
            FROM generate_series(0, 23) AS h
            LEFT JOIN analytics."eventHourly" e ON e."hourOfDay" = h AND ${inScope(s, 'e')}
           GROUP BY h
           ORDER BY h`,
        dimension(s, ['page_open'], 'screen', 15),
        counts(s, {
          passed: 'biometric_validation_completed',
          failed: 'biometric_validation_failed',
          started: 'login_initiated',
          succeeded: 'login_completed',
          pushReceived: 'push_device_handled',
        }),
        dimension(s, ['login_completed'], 'auth_method', null),
        platform.versions(s),
        platform.sessionLength(s),
        platform.platforms(s),
        platform.deviceModels(s),
        platform.delivery(s),
        platform.jobs(s),
      ]);
      return {
        errors: errors.map((r) => ({ ...r })),
        topMessages: messages.map((r) => ({ ...r })),
        daily: series,
        hourly: hourly.map((r) => ({ ...r })),
        screens: screens.map((r) => ({ screen: r.value, opens: r.count })),
        biometrics: { passed: c.passed, failed: c.failed },
        logins: {
          started: c.started,
          succeeded: c.succeeded,
          authMethods: authMethods.map((r) => ({ method: r.value, count: r.count })),
        },
        pushReceived: c.pushReceived,
        versions,
        sessionLength,
        platforms,
        deviceModels,
        delivery,
        jobs: jobs.jobs,
        jobDaily: jobs.daily,
      };
    },
  };
}
