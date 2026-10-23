-- Rollback of 003_dextrans.sql. Database: dexl.
-- Removes the dextrans link and the platform rollups; event rollups are untouched.
-- Afterwards, in database dextrans, run db/rollback/dextrans_reader_drop.sql.
-- The API from the same release reads these tables: roll it back first.

BEGIN;

-- Stop the scheduled refresh (when pg_cron is installed).
DO $$
BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'analytics-dextrans-refresh';
    END IF;
END $$;

DROP PROCEDURE IF EXISTS analytics."refreshDextrans"(integer, integer);
DROP FUNCTION IF EXISTS analytics."refreshDextransProperty"(integer, integer, text, integer, integer);
DROP TABLE IF EXISTS
    analytics."sessionDaily",
    analytics."guestDeviceDaily",
    analytics."eventVersionDaily",
    analytics."pushDeliveryDaily",
    analytics.campaign,
    analytics."campaignFlag",
    analytics."campaignDaily",
    analytics."accountTier",
    analytics."jobRunDaily",
    analytics."jobLatest";
DROP FUNCTION IF EXISTS analytics."normalizeReason"(text);
DROP FUNCTION IF EXISTS analytics."looksLikeTest"(text);

-- The 003 view reads refreshRun.kind; restore the 001 view without it.
DROP VIEW IF EXISTS analytics."refreshStatus";
DELETE FROM analytics."refreshRun" WHERE kind = 'dextrans';
ALTER TABLE analytics."refreshRun" DROP COLUMN IF EXISTS kind;
-- Definition from 001:
CREATE VIEW analytics."refreshStatus" AS
SELECT p."tenantId",
       p."propertyId",
       p.name,
       p."timeZone",
       p.environment,
       (SELECT max(e."createdDate") FROM data."dexAnalytics" e
         WHERE e."tenantId" = p."tenantId" AND e."propertyId" = p."propertyId") AS "latestEventAt",
       (SELECT count(*) FROM analytics."refreshQueue" q
         WHERE q."tenantId" = p."tenantId" AND q."propertyId" = p."propertyId") AS "queuedHours",
       (SELECT min(q."queuedAt") FROM analytics."refreshQueue" q
         WHERE q."tenantId" = p."tenantId" AND q."propertyId" = p."propertyId") AS "oldestQueuedAt",
       (SELECT max(r."finishedAt") FROM analytics."refreshRun" r WHERE r.status = 'succeeded') AS "lastSuccessAt"
  FROM analytics.property p;

-- Foreign tables, the server and every user mapping on it.
DROP SCHEMA IF EXISTS dextrans CASCADE;
DROP SERVER IF EXISTS dextrans CASCADE;
DROP EXTENSION IF EXISTS postgres_fdw;

COMMIT;
