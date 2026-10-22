import type { DailyPoint, ExecutiveData, ExecutiveKpis, FeatureUsage, ItData, MarketingData, Property } from '@phub/contracts';
import type { Sql } from './db.js';

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
}

export interface AnalyticsRepo {
  ping(): Promise<void>;
  properties(): Promise<Property[]>;
  freshness(property: Property): Promise<Freshness>;
  executive(scope: Scope, previous: Scope): Promise<ExecutiveData>;
  marketing(scope: Scope): Promise<MarketingData>;
  it(scope: Scope): Promise<ItData>;
}

interface DimensionRow {
  value: string;
  count: number;
  avgSeconds: number | null;
}

export function createRepo(sql: Sql): AnalyticsRepo {
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
        SELECT "latestEventAt", "lastSuccessAt", "queuedHours", "oldestQueuedAt"
          FROM analytics."refreshStatus"
         WHERE "tenantId" = ${p.tenantId} AND "propertyId" = ${p.propertyId}`;
      return row ? { ...row } : { latestEventAt: null, lastSuccessAt: null, queuedHours: 0, oldestQueuedAt: null };
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

    async marketing(s) {
      const [c, cta, campaigns, messages, denials, geofences, web, promotions, events, drawings] = await Promise.all([
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
      };
    },

    async it(s) {
      const [errors, messages, series, hourly, screens, c, authMethods] = await Promise.all([
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
      };
    },
  };
}
