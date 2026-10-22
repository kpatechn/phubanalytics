-- dextrans rollups vs direct counts through the link (run in dexl after
-- refreshDextrans has covered all history). Counts rows that don't change after
-- they are written: sessions, sends, campaign messages, job runs. Read-only.
-- Every row should say PASS.

WITH
p AS (SELECT "tenantId" AS t, "propertyId" AS pid, "timeZone" AS tz FROM analytics.property),
remote AS (
    SELECT
        (SELECT count(*) FROM dextrans."userSessions" s, p WHERE s."tenantId" = p.t AND s."propertyId" = p.pid
            AND (s."startedAtUtc" AT TIME ZONE p.tz)::date >= (SELECT min("bucketDate") FROM analytics."sessionDaily")) AS sessions,
        (SELECT count(*) FROM dextrans."apnLogs" a, p WHERE a."tenantId" = p.t AND a."propertyId" = p.pid
            AND ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p.tz)::date >= (SELECT min("bucketDate") FROM analytics."pushDeliveryDaily")) AS sends,
        (SELECT count(*) FILTER (WHERE upper(a.status) = 'FAILED') FROM dextrans."apnLogs" a, p WHERE a."tenantId" = p.t AND a."propertyId" = p.pid
            AND ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p.tz)::date >= (SELECT min("bucketDate") FROM analytics."pushDeliveryDaily")) AS failed,
        (SELECT count(*) FROM dextrans."campaignStats" c, p WHERE c."tenantId" = p.t AND c."propertyId" = p.pid AND c."sentAt" IS NOT NULL
            AND (c."sentAt" AT TIME ZONE p.tz)::date >= (SELECT min("bucketDate") FROM analytics."campaignDaily")) AS sent,
        (SELECT count(*) FROM dextrans."jobStatus" j, p WHERE j."tenantId" = p.t AND j."propertyId" = p.pid
            AND (j."startTime" AT TIME ZONE p.tz)::date >= (SELECT min("bucketDate") FROM analytics."jobRunDaily")) AS runs,
        (SELECT count(*) FROM dextrans."campaignMaster" m, p WHERE m."tenantId" = p.t AND m."propertyId" = p.pid) AS campaigns,
        (SELECT count(DISTINCT c."userId") FROM dextrans.cards c, p WHERE c."tenantId" = p.t AND c."propertyId" = p.pid) AS tiered
),
local AS (
    SELECT
        (SELECT coalesce(sum(sessions), 0) FROM analytics."sessionDaily") AS sessions,
        (SELECT coalesce(sum(sessions), 0) FROM analytics."guestDeviceDaily") AS device_sessions,
        (SELECT coalesce(sum(sends), 0) FROM analytics."pushDeliveryDaily") AS sends,
        (SELECT coalesce(sum(sends), 0) FROM analytics."pushDeliveryDaily" WHERE status = 'failed') AS failed,
        (SELECT coalesce(sum(sent), 0) FROM analytics."campaignDaily") AS sent,
        (SELECT coalesce(sum(runs), 0) FROM analytics."jobRunDaily") AS runs,
        (SELECT count(*) FROM analytics.campaign) AS campaigns,
        (SELECT count(*) FROM analytics."accountTier") AS tiered
),
events AS (
    SELECT (SELECT coalesce(sum("eventCount"), 0) FROM analytics."eventVersionDaily") AS by_version,
           (SELECT coalesce(sum(e."eventCount"), 0) FROM analytics."eventDaily" e
             WHERE e."bucketDate" BETWEEN (SELECT min("bucketDate") FROM analytics."eventVersionDaily")
                                      AND (SELECT max("bucketDate") FROM analytics."eventVersionDaily")) AS by_day
),
checks(ord, name, expected, actual) AS (
    SELECT 1, 'Sessions: sessionDaily = dextrans userSessions', remote.sessions::text, local.sessions::text FROM remote, local
    UNION ALL SELECT 2, 'Sessions: guestDeviceDaily = sessionDaily', local.sessions::text, local.device_sessions::text FROM local
    UNION ALL SELECT 3, 'Sends: pushDeliveryDaily = dextrans apnLogs', remote.sends::text, local.sends::text FROM remote, local
    UNION ALL SELECT 4, 'Failed sends: pushDeliveryDaily = apnLogs', remote.failed::text, local.failed::text FROM remote, local
    UNION ALL SELECT 5, 'Campaign messages: campaignDaily = campaignStats', remote.sent::text, local.sent::text FROM remote, local
    UNION ALL SELECT 6, 'Job runs: jobRunDaily = dextrans jobStatus', remote.runs::text, local.runs::text FROM remote, local
    UNION ALL SELECT 7, 'Campaigns: campaign = campaignMaster', remote.campaigns::text, local.campaigns::text FROM remote, local
    UNION ALL SELECT 8, 'Tiered accounts: accountTier = cards accounts', remote.tiered::text, local.tiered::text FROM remote, local
    UNION ALL SELECT 9, 'Events: eventVersionDaily = eventDaily (same days)', events.by_day::text, events.by_version::text FROM events
    UNION ALL SELECT 10, 'Failure reasons with 4+ digit numbers left', '0',
        (SELECT count(*) FROM analytics."pushDeliveryDaily" WHERE reason ~ '[0-9]{4,}')::text
)
SELECT name AS "check", expected, actual, CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END AS result
  FROM checks ORDER BY ord;
