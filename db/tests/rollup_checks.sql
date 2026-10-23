-- Golden values from the plan (section 4): Graton dev, 2026-09-03 to 2026-10-02
-- Pacific, read from the rollups. Dev only: other environments run
-- rollup_invariants.sql on its own. Read-only. Every row should say PASS.

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
)
SELECT name AS "check", expected, actual, CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END AS result
  FROM checks ORDER BY ord;

\ir rollup_invariants.sql
