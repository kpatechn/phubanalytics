-- Rollup checks: plan section 4 golden values (Graton dev, 2026-09-03 to 2026-10-02
-- Pacific) read from the rollups, plus invariants that every rollup agrees with raw
-- events on every day. Read-only, so it can also run against dev after deployment.
-- Every row should say PASS.

WITH
w AS (SELECT 15001 AS t, 1500001 AS p, date '2026-09-03' AS d0, date '2026-10-02' AS d1, 'America/Los_Angeles' AS tz),
ed AS (
    SELECT e.* FROM analytics."eventDaily" e, w
     WHERE e."tenantId" = w.t AND e."propertyId" = w.p AND e."bucketDate" BETWEEN w.d0 AND w.d1),
dim AS (
    SELECT x.* FROM analytics."eventDimensionDaily" x, w
     WHERE x."tenantId" = w.t AND x."propertyId" = w.p AND x."bucketDate" BETWEEN w.d0 AND w.d1),
err AS (
    SELECT x.* FROM analytics."apiErrorDaily" x, w
     WHERE x."tenantId" = w.t AND x."propertyId" = w.p AND x."bucketDate" BETWEEN w.d0 AND w.d1),
ge AS (
    SELECT x.* FROM analytics."guestEventDaily" x, w
     WHERE x."tenantId" = w.t AND x."propertyId" = w.p AND x."bucketDate" BETWEEN w.d0 AND w.d1),
n AS (
    SELECT "eventId", sum("eventCount") AS c FROM ed GROUP BY 1),

-- Raw events per property-local day (excluded accounts left out), for invariants.
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
rule_dim_day AS (
    SELECT "tenantId", "propertyId", "bucketDate" AS day, "eventId", "dimensionType", sum("eventCount") AS c
      FROM analytics."eventDimensionDaily" GROUP BY 1, 2, 3, 4, 5),

checks(ord, name, expected, actual) AS (
    SELECT 1,  'Total events',                          '3494',              (SELECT coalesce(sum(c), 0) FROM n)::text
    UNION ALL SELECT 2,  'Sessions started',            '186',               (SELECT coalesce(sum(c), 0) FROM n WHERE "eventId" = 'session_started')::text
    UNION ALL SELECT 3,  'App opens',                   '230',               (SELECT coalesce(sum(c), 0) FROM n WHERE "eventId" = 'app_opened')::text
    UNION ALL SELECT 4,  'Login attempts / successes',  '58 / 55',
        (SELECT coalesce(sum(c) FILTER (WHERE "eventId" = 'login_initiated'), 0) || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'login_completed'), 0) FROM n)
    UNION ALL SELECT 5,  'Accounts logged in (userId; plan says 13 by player_id)', '8',
        (SELECT count(DISTINCT "userId") FROM ge WHERE "eventId" = 'login_completed')::text
    UNION ALL SELECT 6,  'On-property events',          '1877',              (SELECT coalesce(sum("eventCount"), 0) FROM ed WHERE "locationContext" = 'onsite')::text
    UNION ALL SELECT 7,  'API errors',                  '438',               (SELECT coalesce(sum(c), 0) FROM n WHERE "eventId" = 'api_error')::text
    UNION ALL SELECT 8,  'Errors on analyticLogs / points', '227 / 159',
        (SELECT coalesce(sum("eventCount") FILTER (WHERE endpoint ILIKE '%analyticLogs%'), 0) || ' / ' || coalesce(sum("eventCount") FILTER (WHERE endpoint ILIKE '%points%'), 0) FROM err)
    UNION ALL SELECT 9,  'Inbox views / opened / read / deleted', '84 / 38 / 38 / 76',
        (SELECT coalesce(sum(c) FILTER (WHERE "eventId" = 'notification_list_viewed'), 0) || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'notification_details_viewed'), 0)
             || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'notification_marked_read'), 0) || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'notification_deleted'), 0) FROM n)
    UNION ALL SELECT 10, 'Push opens / foreground receipts', '16 / 20',
        (SELECT coalesce(sum(c) FILTER (WHERE "eventId" = 'push_opened'), 0) || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'push_device_handled'), 0) FROM n)
    UNION ALL SELECT 11, 'Geofence entries / exits',    '327 / 9',
        (SELECT coalesce(sum(c) FILTER (WHERE "eventId" = 'geofence_entered'), 0) || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'geofence_exited'), 0) FROM n)
    UNION ALL SELECT 12, 'Biometric passed / failed',   '21 / 2',
        (SELECT coalesce(sum(c) FILTER (WHERE "eventId" = 'biometric_validation_completed'), 0) || ' / ' || coalesce(sum(c) FILTER (WHERE "eventId" = 'biometric_validation_failed'), 0) FROM n)
    UNION ALL SELECT 13, 'Push opens with unknown_campaign', '16',
        (SELECT coalesce(sum("eventCount"), 0) FROM dim WHERE "dimensionType" = 'campaign' AND "dimensionValue" = 'unknown_campaign')::text
    UNION ALL SELECT 14, 'Denials skipped / permanently_denied', '18 / 2',
        (SELECT coalesce(sum("eventCount") FILTER (WHERE "dimensionValue" = 'skipped'), 0) || ' / ' || coalesce(sum("eventCount") FILTER (WHERE "dimensionValue" = 'permanently_denied'), 0)
           FROM dim WHERE "dimensionType" = 'denial_type')
    UNION ALL SELECT 15, 'Messages with is_cta_completed = false', '38',
        (SELECT coalesce(sum("eventCount"), 0) FROM dim WHERE "dimensionType" = 'cta_completed' AND "dimensionValue" = 'false')::text
    UNION ALL SELECT 16, 'Wallet events offsite / total', '53 / 76',
        (SELECT coalesce(sum(e."eventCount") FILTER (WHERE e."locationContext" = 'offsite'), 0) || ' / ' || coalesce(sum(e."eventCount"), 0)
           FROM ed e JOIN analytics."eventCatalog" c ON c."eventId" = e."eventId" WHERE c.feature = 'Wallet')
    UNION ALL SELECT 17, 'Card-link starts offsite / total', '26 / 35',
        (SELECT coalesce(sum("eventCount") FILTER (WHERE "locationContext" = 'offsite'), 0) || ' / ' || coalesce(sum("eventCount"), 0)
           FROM ed WHERE "eventId" = 'link_account_clicked')
    -- Invariants over every day of every property
    UNION ALL SELECT 50, 'Days where eventDaily <> raw (local day)', '0',
        (SELECT count(*) FROM raw_day r FULL JOIN daily d USING ("tenantId", "propertyId", day) WHERE r.c IS DISTINCT FROM d.c)::text
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
          WHERE r.accounts IS DISTINCT FROM g.accounts OR r.c IS DISTINCT FROM g.c)::text
    UNION ALL SELECT 57, 'Queued hours left after refresh', '0',
        (SELECT count(*) FROM analytics."refreshQueue")::text
)
SELECT name AS "check", expected, actual, CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END AS result
  FROM checks ORDER BY ord;
