-- dextrans rollups vs direct counts through the link (run in dexl once
-- refreshDextrans has covered the history). Compares rows that don't change once
-- written (sessions, sends, campaign messages, job runs) on every day before
-- today in each property's time zone, so rows arriving today never cause a
-- false failure. Environment-neutral and read-only. Every row should say PASS.
-- The campaign and tier rows compare snapshots: if one is off by a few, a
-- campaign or card changed since the last refresh; rerun after the next one.

WITH
p AS (SELECT "tenantId" AS t, "propertyId" AS pid, "timeZone" AS tz, (now() AT TIME ZONE "timeZone")::date AS today
        FROM analytics.property),
since AS (
    SELECT (SELECT min("bucketDate") FROM analytics."sessionDaily")      AS sessions,
           (SELECT min("bucketDate") FROM analytics."pushDeliveryDaily") AS sends,
           (SELECT min("bucketDate") FROM analytics."campaignDaily")     AS campaigns,
           (SELECT min("bucketDate") FROM analytics."jobRunDaily")       AS jobs,
           (SELECT min("bucketDate") FROM analytics."eventVersionDaily") AS events),
remote AS (
    SELECT
        (SELECT count(*) FROM dextrans."userSessions" s, p, since WHERE s."tenantId" = p.t AND s."propertyId" = p.pid
            AND (s."startedAtUtc" AT TIME ZONE p.tz)::date >= since.sessions AND (s."startedAtUtc" AT TIME ZONE p.tz)::date < p.today) AS sessions,
        (SELECT count(*) FROM dextrans."apnLogs" a, p, since WHERE a."tenantId" = p.t AND a."propertyId" = p.pid
            AND ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p.tz)::date >= since.sends
            AND ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p.tz)::date < p.today) AS sends,
        (SELECT count(*) FROM dextrans."apnLogs" a, p, since WHERE a."tenantId" = p.t AND a."propertyId" = p.pid AND upper(a.status) = 'FAILED'
            AND ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p.tz)::date >= since.sends
            AND ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p.tz)::date < p.today) AS failed,
        (SELECT count(*) FROM dextrans."campaignStats" c, p, since WHERE c."tenantId" = p.t AND c."propertyId" = p.pid
            AND (c."sentAt" AT TIME ZONE p.tz)::date >= since.campaigns AND (c."sentAt" AT TIME ZONE p.tz)::date < p.today) AS sent,
        (SELECT count(*) FROM dextrans."jobStatus" j, p, since WHERE j."tenantId" = p.t AND j."propertyId" = p.pid
            AND (j."startTime" AT TIME ZONE p.tz)::date >= since.jobs AND (j."startTime" AT TIME ZONE p.tz)::date < p.today) AS runs,
        (SELECT count(*) FROM dextrans."campaignMaster" m, p WHERE m."tenantId" = p.t AND m."propertyId" = p.pid) AS campaigns,
        (SELECT count(DISTINCT c."userId") FROM dextrans.cards c, p WHERE c."tenantId" = p.t AND c."propertyId" = p.pid) AS tiered
),
local AS (
    SELECT
        (SELECT coalesce(sum(d.sessions), 0) FROM analytics."sessionDaily" d JOIN p ON p.t = d."tenantId" AND p.pid = d."propertyId" WHERE d."bucketDate" < p.today) AS sessions,
        (SELECT coalesce(sum(d.sessions), 0) FROM analytics."guestDeviceDaily" d JOIN p ON p.t = d."tenantId" AND p.pid = d."propertyId" WHERE d."bucketDate" < p.today) AS device_sessions,
        (SELECT coalesce(sum(d.sends), 0) FROM analytics."pushDeliveryDaily" d JOIN p ON p.t = d."tenantId" AND p.pid = d."propertyId" WHERE d."bucketDate" < p.today) AS sends,
        (SELECT coalesce(sum(d.sends), 0) FROM analytics."pushDeliveryDaily" d JOIN p ON p.t = d."tenantId" AND p.pid = d."propertyId" WHERE d."bucketDate" < p.today AND d.status = 'failed') AS failed,
        (SELECT coalesce(sum(d.sent), 0) FROM analytics."campaignDaily" d JOIN p ON p.t = d."tenantId" AND p.pid = d."propertyId" WHERE d."bucketDate" < p.today) AS sent,
        (SELECT coalesce(sum(d.runs), 0) FROM analytics."jobRunDaily" d JOIN p ON p.t = d."tenantId" AND p.pid = d."propertyId" WHERE d."bucketDate" < p.today) AS runs,
        (SELECT count(*) FROM analytics.campaign) AS campaigns,
        (SELECT count(*) FROM analytics."accountTier") AS tiered
),
events AS (
    SELECT (SELECT coalesce(sum(v."eventCount"), 0) FROM analytics."eventVersionDaily" v JOIN p ON p.t = v."tenantId" AND p.pid = v."propertyId"
             WHERE v."bucketDate" < p.today) AS by_version,
           (SELECT coalesce(sum(e."eventCount"), 0) FROM analytics."eventDaily" e JOIN p ON p.t = e."tenantId" AND p.pid = e."propertyId", since
             WHERE e."bucketDate" >= since.events AND e."bucketDate" < p.today) AS by_day
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
