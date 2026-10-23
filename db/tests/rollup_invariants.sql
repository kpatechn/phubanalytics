-- Rollup invariants: every rollup agrees with raw events, and with each other, on
-- every day of every property. Environment-neutral and read-only: run it in any
-- environment after deployment. Days whose refresh is still queued are skipped,
-- because new events keep arriving in a live system. Every row should say PASS.
-- Scans all raw events: give it time on large databases (statement_timeout).

WITH
-- Local days with refresh work still queued (events newer than the last refresh).
pending AS (
    SELECT DISTINCT q."tenantId", q."propertyId", ld.day
      FROM analytics."refreshQueue" q
      JOIN analytics.property p ON p."tenantId" = q."tenantId" AND p."propertyId" = q."propertyId"
     CROSS JOIN LATERAL (VALUES ((q."bucketHour" AT TIME ZONE p."timeZone")::date),
                                (((q."bucketHour" + interval '1 hour' - interval '1 microsecond') AT TIME ZONE p."timeZone")::date)) ld(day)),
-- Raw events per property-local day (excluded accounts left out).
raw_day AS (
    SELECT e."tenantId", e."propertyId", (e."createdDate" AT TIME ZONE p."timeZone")::date AS day, count(*) AS c
      FROM data."dexAnalytics" e
      JOIN analytics.property p ON p."tenantId" = e."tenantId" AND p."propertyId" = e."propertyId"
     WHERE NOT EXISTS (SELECT 1 FROM analytics."excludedUser" x
                        WHERE x."tenantId" = e."tenantId" AND x."propertyId" = e."propertyId" AND x."userId" = e."userId")
     GROUP BY 1, 2, 3),
daily AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, sum("eventCount") AS c FROM analytics."eventDaily" GROUP BY 1, 2, 3),
hourly AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, sum("eventCount") AS c FROM analytics."eventHourly" GROUP BY 1, 2, 3),
guest AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, sum("eventCount") AS c FROM analytics."guestEventDaily" GROUP BY 1, 2, 3),
guest_day AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, sum("eventCount") AS c FROM analytics."guestDaily" GROUP BY 1, 2, 3),
errors_day AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, sum("eventCount") AS c FROM analytics."apiErrorDaily" GROUP BY 1, 2, 3),
api_error_day AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, sum("eventCount") AS c FROM analytics."eventDaily"
     WHERE "eventId" = 'api_error' GROUP BY 1, 2, 3),
rule_event_day AS (
    SELECT d."tenantId", d."propertyId", d."bucketDate" AS day, r."eventId", r."dimensionType", sum(d."eventCount") AS c
      FROM analytics."eventDaily" d JOIN analytics."dimensionRule" r ON r."eventId" = d."eventId" AND r."isActive"
     GROUP BY 1, 2, 3, 4, 5),
rule_dim_day AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, "eventId", "dimensionType", sum("eventCount") AS c
      FROM analytics."eventDimensionDaily" GROUP BY 1, 2, 3, 4, 5),
-- Accounts with a foreground event, per local day, straight from raw events.
raw_active AS (
    SELECT e."tenantId", e."propertyId", (e."createdDate" AT TIME ZONE p."timeZone")::date AS day,
           count(DISTINCT e."userId") AS accounts, count(*) AS c
      FROM data."dexAnalytics" e
      JOIN analytics.property p ON p."tenantId" = e."tenantId" AND p."propertyId" = e."propertyId"
      JOIN analytics."eventCatalog" c ON c."eventId" = e."eventId" AND c."isForeground"
     WHERE nullif(btrim(e."userId"), '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM analytics."excludedUser" x
                        WHERE x."tenantId" = e."tenantId" AND x."propertyId" = e."propertyId" AND x."userId" = e."userId")
     GROUP BY 1, 2, 3),
rollup_active AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day,
           count(*) FILTER (WHERE "foregroundEventCount" > 0) AS accounts, sum("foregroundEventCount") AS c
      FROM analytics."guestDaily" GROUP BY 1, 2, 3
    HAVING sum("foregroundEventCount") > 0),

checks(ord, name, expected, actual) AS (
    SELECT 50, 'Days where eventDaily <> raw (local day)', '0',
        (SELECT count(*) FROM raw_day r FULL JOIN daily d USING ("tenantId", "propertyId", day)
          WHERE r.c IS DISTINCT FROM d.c
            AND NOT EXISTS (SELECT 1 FROM pending x WHERE x."tenantId" = coalesce(r."tenantId", d."tenantId")
                              AND x."propertyId" = coalesce(r."propertyId", d."propertyId") AND x.day = coalesce(r.day, d.day)))::text
    UNION ALL SELECT 51, 'Days where eventHourly <> eventDaily', '0',
        (SELECT count(*) FROM daily d FULL JOIN hourly h USING ("tenantId", "propertyId", day) WHERE d.c IS DISTINCT FROM h.c)::text
    UNION ALL SELECT 52, 'Days where guestEventDaily <> eventDaily', '0',
        (SELECT count(*) FROM daily d FULL JOIN guest g USING ("tenantId", "propertyId", day) WHERE d.c IS DISTINCT FROM g.c)::text
    UNION ALL SELECT 53, 'Days where guestDaily <> eventDaily', '0',
        (SELECT count(*) FROM daily d FULL JOIN guest_day g USING ("tenantId", "propertyId", day) WHERE d.c IS DISTINCT FROM g.c)::text
    UNION ALL SELECT 54, 'Days where apiErrorDaily <> api_error events', '0',
        (SELECT count(*) FROM api_error_day a FULL JOIN errors_day e USING ("tenantId", "propertyId", day) WHERE a.c IS DISTINCT FROM e.c)::text
    UNION ALL SELECT 55, 'Rule-days where dimension total <> event count', '0',
        (SELECT count(*) FROM rule_event_day a FULL JOIN rule_dim_day b USING ("tenantId", "propertyId", day, "eventId", "dimensionType") WHERE a.c IS DISTINCT FROM b.c)::text
    UNION ALL SELECT 56, 'Days where active accounts (foreground) <> raw', '0',
        (SELECT count(*) FROM raw_active r FULL JOIN rollup_active g USING ("tenantId", "propertyId", day)
          WHERE (r.accounts IS DISTINCT FROM g.accounts OR r.c IS DISTINCT FROM g.c)
            AND NOT EXISTS (SELECT 1 FROM pending x WHERE x."tenantId" = coalesce(r."tenantId", g."tenantId")
                              AND x."propertyId" = coalesce(r."propertyId", g."propertyId") AND x.day = coalesce(r.day, g.day)))::text
    UNION ALL SELECT 57, 'Queued hours waiting more than 15 minutes', '0',
        (SELECT count(*) FROM analytics."refreshQueue" WHERE "queuedAt" < now() - interval '15 minutes')::text
)
SELECT name AS "check", expected, actual, CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END AS result
  FROM checks ORDER BY ord;
