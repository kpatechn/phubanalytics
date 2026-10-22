-- Run in database dextrans as the owner of its schemas (scripts/link-dextrans.sh does this).
-- Creates, or rotates the password of, the login role that analytics uses to read
-- dextrans. It can SELECT only the columns analytics needs: no names, contacts,
-- card numbers, tokens, OTPs, IP addresses or locations.
--
-- The password arrives as a SCRAM verifier (env DEXTRANS_READER_VERIFIER), so the
-- plaintext never reaches the server, its logs or pg_stat_statements.

\set ON_ERROR_STOP on
\getenv reader_verifier DEXTRANS_READER_VERIFIER
SET pg_stat_statements.track_utility = off;

SELECT format('CREATE ROLE analytics_dextrans_reader LOGIN PASSWORD %L', :'reader_verifier')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_dextrans_reader') \gexec

-- New roles are never superuser and can't create databases or roles; RDS doesn't
-- let a non-superuser even restate those attributes, so they're left at defaults.
ALTER ROLE analytics_dextrans_reader WITH LOGIN NOINHERIT CONNECTION LIMIT 5 PASSWORD :'reader_verifier';
-- Settings and CONNECT apply to the database this script runs in.
SELECT format('ALTER ROLE analytics_dextrans_reader IN DATABASE %I SET default_transaction_read_only = on', current_database()) \gexec
SELECT format('ALTER ROLE analytics_dextrans_reader IN DATABASE %I SET statement_timeout = %L', current_database(), '120s') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO analytics_dextrans_reader', current_database()) \gexec
GRANT USAGE ON SCHEMA dexauth, dexcomm, dexcron, dexpatron, phcamp TO analytics_dextrans_reader;

-- Column-level grants: the same columns as the foreign tables in migration 003.
GRANT SELECT ("sessionId", "tenantId", "propertyId", "dexUserId", "deviceId", platform, "appVersion",
              "locationContext", "startedAtUtc", "endedAtUtc")
    ON dexauth."userSessions" TO analytics_dextrans_reader;
GRANT SELECT ("deviceId", "tenantId", "propertyId", "userId", "systemName", "deviceName", version, "modifiedDate")
    ON dexauth."deviceInfos" TO analytics_dextrans_reader;
GRANT SELECT (id, "notifiedAt", event, "tenantId", "propertyId", status, "respMsg")
    ON dexcomm."apnLogs" TO analytics_dextrans_reader;
GRANT SELECT (id, "tenantId", "propertyId", name, category, status, "targetType", "scheduleType",
              "startDate", "endDate", "isDelete")
    ON phcamp."campaignMaster" TO analytics_dextrans_reader;
GRANT SELECT ("campaignStatId", "tenantId", "propertyId", "campaignId", channel, status,
              "sentAt", "deliveredAt", "openedAt", "clickedAt", "convertedAt", "unSubAt")
    ON phcamp."campaignStats" TO analytics_dextrans_reader;
GRANT SELECT ("userId", "tenantId", "propertyId", "clubName", "isActive", "modifiedDate")
    ON dexpatron.cards TO analytics_dextrans_reader;
GRANT SELECT ("jobExecutionId", "tenantId", "propertyId", "jobName", "startTime", "endTime", status)
    ON dexcron."jobStatus" TO analytics_dextrans_reader;
