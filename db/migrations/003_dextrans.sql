-- 003_dextrans.sql
-- Database: dexl. Brings platform data from database dextrans into the rollups:
-- sessions (platform, app version, length), devices, push delivery, campaign
-- funnels, loyalty tiers and scheduled jobs.
--
--   * postgres_fdw foreign tables in schema "dextrans", read through the role
--     analytics_dextrans_reader (db/ops/dextrans_reader.sql). They declare only
--     the columns analytics needs; the role can read nothing else.
--   * Connection details and the login are per environment:
--     scripts/link-dextrans.sh (db/ops/link_dextrans.sql).
--   * analytics."refreshDextrans"() rebuilds the last few property-local days
--     (campaigns: last 45 days of sends) and the snapshot tables. It runs on its
--     own pg_cron job, so a dextrans outage never blocks the event rollups.
--   * Only counts and pseudonymous IDs (account and device) are stored. Failure
--     reasons are normalized: tokens, IDs and card numbers are removed.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

CREATE SERVER IF NOT EXISTS dextrans FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (dbname 'dextrans', fetch_size '10000');

CREATE SCHEMA IF NOT EXISTS dextrans;
COMMENT ON SCHEMA dextrans IS 'Read-only foreign tables over database dextrans (postgres_fdw); only the columns analytics needs.';

CREATE FOREIGN TABLE dextrans."userSessions" (
    "sessionId"       uuid,
    "tenantId"        integer,
    "propertyId"      integer,
    "dexUserId"       uuid,
    "deviceId"        varchar,
    platform          varchar,
    "appVersion"      varchar,
    "locationContext" varchar,
    "startedAtUtc"    timestamptz,
    "endedAtUtc"      timestamptz
) SERVER dextrans OPTIONS (schema_name 'dexauth', table_name 'userSessions');

CREATE FOREIGN TABLE dextrans."deviceInfos" (
    "deviceId"     varchar,
    "tenantId"     integer,
    "propertyId"   integer,
    "userId"       uuid,
    "systemName"   varchar,
    "deviceName"   varchar,
    version        varchar,
    "modifiedDate" timestamptz
) SERVER dextrans OPTIONS (schema_name 'dexauth', table_name 'deviceInfos');

-- notifiedAt is a UTC timestamp without time zone.
CREATE FOREIGN TABLE dextrans."apnLogs" (
    id           uuid,
    "notifiedAt" timestamp,
    event        varchar,
    "tenantId"   integer,
    "propertyId" integer,
    status       varchar,
    "respMsg"    text
) SERVER dextrans OPTIONS (schema_name 'dexcomm', table_name 'apnLogs');

CREATE FOREIGN TABLE dextrans."campaignMaster" (
    id             uuid,
    "tenantId"     integer,
    "propertyId"   integer,
    name           varchar,
    category       varchar,
    status         varchar,
    "targetType"   varchar,
    "scheduleType" varchar,
    "startDate"    timestamptz,
    "endDate"      timestamptz,
    "isDelete"     boolean
) SERVER dextrans OPTIONS (schema_name 'phcamp', table_name 'campaignMaster');

CREATE FOREIGN TABLE dextrans."campaignStats" (
    "campaignStatId" uuid,
    "tenantId"       integer,
    "propertyId"     integer,
    "campaignId"     uuid,
    channel          varchar,
    status           varchar,
    "sentAt"         timestamptz,
    "deliveredAt"    timestamptz,
    "openedAt"       timestamptz,
    "clickedAt"      timestamptz,
    "convertedAt"    timestamptz,
    "unSubAt"        timestamptz
) SERVER dextrans OPTIONS (schema_name 'phcamp', table_name 'campaignStats');

CREATE FOREIGN TABLE dextrans.cards (
    "userId"       uuid,
    "tenantId"     integer,
    "propertyId"   integer,
    "clubName"     varchar,
    "isActive"     boolean,
    "modifiedDate" timestamptz
) SERVER dextrans OPTIONS (schema_name 'dexpatron', table_name 'cards');

CREATE FOREIGN TABLE dextrans."jobStatus" (
    "jobExecutionId" uuid,
    "tenantId"       integer,
    "propertyId"     integer,
    "jobName"        varchar,
    "startTime"      timestamptz,
    "endTime"        timestamptz,
    status           varchar
) SERVER dextrans OPTIONS (schema_name 'dexcron', table_name 'jobStatus');

-- Helpers ------------------------------------------------------------------------

-- Names that look like tests ("test", "Dev Test-6", "Promotion Test2", "Dev Pre-Demo").
CREATE FUNCTION analytics."looksLikeTest"(p_name text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT coalesce(p_name ~* '\m(test|tests|testing|qa|demo|dummy|sample)[0-9]*\M', false)
$$;

-- A failure reason without tokens, IDs or account/card numbers, so similar reasons group together.
CREATE FUNCTION analytics."normalizeReason"(p_reason text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN p_reason IS NULL OR btrim(p_reason) = '' THEN '(none)'
                ELSE left(regexp_replace(regexp_replace(analytics."normalizeErrorMessage"(p_reason),
                                                        '[A-Za-z0-9_:-]{25,}', '{id}', 'g'),
                                         '[0-9]{4,}', '{n}', 'g'), 200)
           END
$$;

-- Rollups (days are property-local) --------------------------------------------

-- Sessions by platform, app version and on/off property. Length only for sessions
-- that ended (within 24 hours); the buckets give a length distribution and median.
CREATE TABLE analytics."sessionDaily" (
    "tenantId"        integer     NOT NULL,
    "propertyId"      integer     NOT NULL,
    "bucketDate"      date        NOT NULL,
    platform          text        NOT NULL,
    "appVersion"      text        NOT NULL,
    "locationContext" text        NOT NULL,
    sessions          bigint      NOT NULL,
    "endedSessions"   bigint      NOT NULL,
    "durationSeconds" numeric     NOT NULL,
    "lengthUnder30s"  bigint      NOT NULL,
    "length30sTo1m"   bigint      NOT NULL,
    "length1To5m"     bigint      NOT NULL,
    "length5To15m"    bigint      NOT NULL,
    "length15To60m"   bigint      NOT NULL,
    "lengthOver60m"   bigint      NOT NULL,
    "refreshedAt"     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", platform, "appVersion", "locationContext")
);

-- One row per account, device, platform and version per day: distinct accounts and
-- devices over any range, device models, version adoption. Contains account and device IDs.
CREATE TABLE analytics."guestDeviceDaily" (
    "tenantId"    integer     NOT NULL,
    "propertyId"  integer     NOT NULL,
    "bucketDate"  date        NOT NULL,
    "userId"      varchar(36) NOT NULL,
    "deviceId"    text        NOT NULL,
    platform      text        NOT NULL,
    "appVersion"  text        NOT NULL,
    model         text        NOT NULL,
    sessions      bigint      NOT NULL,
    "refreshedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "userId", "deviceId", platform, "appVersion")
);

-- App events (and API errors) by the platform and version of the session that sent them.
CREATE TABLE analytics."eventVersionDaily" (
    "tenantId"    integer     NOT NULL,
    "propertyId"  integer     NOT NULL,
    "bucketDate"  date        NOT NULL,
    platform      text        NOT NULL,
    "appVersion"  text        NOT NULL,
    "eventCount"  bigint      NOT NULL,
    "errorCount"  bigint      NOT NULL,
    "refreshedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", platform, "appVersion")
);

-- Every outbound message the platform tried to send (push, email, SMS, real-time).
-- reason is the normalized failure reason, '' when not failed.
CREATE TABLE analytics."pushDeliveryDaily" (
    "tenantId"    integer     NOT NULL,
    "propertyId"  integer     NOT NULL,
    "bucketDate"  date        NOT NULL,
    "messageType" text        NOT NULL,
    status        text        NOT NULL,
    reason        text        NOT NULL,
    sends         bigint      NOT NULL,
    "refreshedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "messageType", status, reason)
);

-- Manual test/real override for campaigns; otherwise the name decides.
CREATE TABLE analytics."campaignFlag" (
    "campaignId" uuid        PRIMARY KEY,
    "isTest"     boolean     NOT NULL,
    reason       text        NOT NULL,
    "createdAt"  timestamptz NOT NULL DEFAULT now()
);

-- Snapshot of campaign definitions, replaced on every refresh.
CREATE TABLE analytics.campaign (
    "tenantId"     integer     NOT NULL,
    "propertyId"   integer     NOT NULL,
    "campaignId"   uuid        NOT NULL,
    name           text        NOT NULL,
    category       text        NOT NULL,
    status         text        NOT NULL,
    "targetType"   text        NOT NULL,
    "scheduleType" text        NOT NULL,
    "startDate"    timestamptz,
    "endDate"      timestamptz,
    "isDeleted"    boolean     NOT NULL,
    "isTest"       boolean     NOT NULL,
    "refreshedAt"  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "campaignId")
);

-- Campaign funnel by the local day each message was sent: of the messages sent
-- that day, how many were later delivered, opened, clicked, converted.
CREATE TABLE analytics."campaignDaily" (
    "tenantId"     integer     NOT NULL,
    "propertyId"   integer     NOT NULL,
    "bucketDate"   date        NOT NULL,
    "campaignId"   uuid        NOT NULL,
    channel        text        NOT NULL,
    sent           bigint      NOT NULL,
    delivered      bigint      NOT NULL,
    opened         bigint      NOT NULL,
    clicked        bigint      NOT NULL,
    converted      bigint      NOT NULL,
    unsubscribed   bigint      NOT NULL,
    "refreshedAt"  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "campaignId", channel)
);

-- Current loyalty tier per account (active card, else most recent), replaced on
-- every refresh. History is segmented by today's tier. Contains account IDs.
CREATE TABLE analytics."accountTier" (
    "tenantId"    integer     NOT NULL,
    "propertyId"  integer     NOT NULL,
    "userId"      varchar(36) NOT NULL,
    tier          text        NOT NULL,
    "refreshedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "userId")
);

-- Scheduled job runs by local start day. stuck = started over an hour ago and never finished.
CREATE TABLE analytics."jobRunDaily" (
    "tenantId"           integer     NOT NULL,
    "propertyId"         integer     NOT NULL,
    "bucketDate"         date        NOT NULL,
    "jobName"            text        NOT NULL,
    runs                 bigint      NOT NULL,
    completed            bigint      NOT NULL,
    failed               bigint      NOT NULL,
    stuck                bigint      NOT NULL,
    running              bigint      NOT NULL,
    "durationSeconds"    numeric     NOT NULL,
    "durationCount"      bigint      NOT NULL,
    "maxDurationSeconds" numeric,
    "refreshedAt"        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "jobName")
);

-- Latest run per job over the last 30 days, replaced on every refresh.
CREATE TABLE analytics."jobLatest" (
    "tenantId"      integer     NOT NULL,
    "propertyId"    integer     NOT NULL,
    "jobName"       text        NOT NULL,
    "isTest"        boolean     NOT NULL,
    "lastStartAt"   timestamptz NOT NULL,
    "lastStatus"    text        NOT NULL,
    "lastSuccessAt" timestamptz,
    "lastFailureAt" timestamptz,
    "refreshedAt"   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "jobName")
);

-- Refresh bookkeeping: tell event refreshes and dextrans refreshes apart.
ALTER TABLE analytics."refreshRun"
    ADD COLUMN kind text NOT NULL DEFAULT 'events' CHECK (kind IN ('events', 'dextrans'));

CREATE OR REPLACE VIEW analytics."refreshStatus" AS
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
       (SELECT max(r."finishedAt") FROM analytics."refreshRun" r WHERE r.status = 'succeeded' AND r.kind = 'events') AS "lastSuccessAt",
       (SELECT max(r."finishedAt") FROM analytics."refreshRun" r WHERE r.status = 'succeeded' AND r.kind = 'dextrans') AS "dextransRefreshedAt"
  FROM analytics.property p;

-- Refresh ------------------------------------------------------------------------

-- Rebuild one property's dextrans rollups for the last p_days local days
-- (campaign sends: last p_campaign_days) and its snapshots. One transaction.
-- Returns the number of foreign rows read.
CREATE FUNCTION analytics."refreshDextransProperty"(
    p_tenant_id integer, p_property_id integer, p_tz text, p_days integer, p_campaign_days integer
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_today date        := (now() AT TIME ZONE p_tz)::date;
    v_first date        := (now() AT TIME ZONE p_tz)::date - (p_days - 1);
    v_from  timestamptz := ((now() AT TIME ZONE p_tz)::date - (p_days - 1))::timestamp AT TIME ZONE p_tz;
    v_to    timestamptz := ((now() AT TIME ZONE p_tz)::date + 1)::timestamp AT TIME ZONE p_tz;
    v_cfirst date       := (now() AT TIME ZONE p_tz)::date - (p_campaign_days - 1);
    v_cfrom timestamptz := ((now() AT TIME ZONE p_tz)::date - (p_campaign_days - 1))::timestamp AT TIME ZONE p_tz;
    v_rows  bigint      := 0;
    v_session_ids uuid[];
    n       bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(format('analytics.refreshDextrans:%s:%s', p_tenant_id, p_property_id), 0));

    -- Sessions that started in the window, plus any older session that an event in
    -- the window belongs to (sessions can stay open for days). The ID list is sent
    -- to dextrans as one array parameter, so the filter runs there.
    SELECT array_agg(DISTINCT e."sessionId") INTO v_session_ids
      FROM data."dexAnalytics" e
     WHERE e."tenantId" = p_tenant_id AND e."propertyId" = p_property_id
       AND e."createdDate" >= v_from AND e."createdDate" < v_to;

    CREATE TEMP TABLE IF NOT EXISTS "dxSessions" (
        "sessionId"       uuid,
        "userId"          varchar(36),
        "deviceId"        text,
        platform          text,
        "appVersion"      text,
        "locationContext" text,
        "startedAt"       timestamptz,
        "endedAt"         timestamptz
    ) ON COMMIT DROP;
    TRUNCATE pg_temp."dxSessions";
    INSERT INTO pg_temp."dxSessions"
    SELECT s."sessionId", s."dexUserId"::text, nullif(btrim(s."deviceId"), ''),
           lower(coalesce(nullif(btrim(s.platform), ''), 'unknown')),
           coalesce(nullif(btrim(s."appVersion"), ''), 'unknown'),
           CASE lower(btrim(s."locationContext")) WHEN 'onsite' THEN 'onsite' WHEN 'offsite' THEN 'offsite' ELSE 'unknown' END,
           s."startedAtUtc", s."endedAtUtc"
      FROM dextrans."userSessions" s
     WHERE s."tenantId" = p_tenant_id AND s."propertyId" = p_property_id
       AND ((s."startedAtUtc" >= v_from AND s."startedAtUtc" < v_to) OR s."sessionId" = ANY (v_session_ids));
    GET DIAGNOSTICS n = ROW_COUNT;
    v_rows := v_rows + n;

    -- Device model: the most recently updated registry row per device.
    CREATE TEMP TABLE IF NOT EXISTS "dxDevices" ("deviceId" text PRIMARY KEY, model text) ON COMMIT DROP;
    TRUNCATE pg_temp."dxDevices";
    INSERT INTO pg_temp."dxDevices"
    SELECT DISTINCT ON (d."deviceId") d."deviceId", coalesce(nullif(btrim(d."deviceName"), ''), 'unknown')
      FROM dextrans."deviceInfos" d
     WHERE d."tenantId" = p_tenant_id AND d."propertyId" = p_property_id AND d."deviceId" IS NOT NULL
     ORDER BY d."deviceId", d."modifiedDate" DESC NULLS LAST;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_rows := v_rows + n;

    DELETE FROM analytics."sessionDaily"
     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" BETWEEN v_first AND v_today;
    INSERT INTO analytics."sessionDaily"
        ("tenantId", "propertyId", "bucketDate", platform, "appVersion", "locationContext", sessions, "endedSessions",
         "durationSeconds", "lengthUnder30s", "length30sTo1m", "length1To5m", "length5To15m", "length15To60m", "lengthOver60m")
    SELECT p_tenant_id, p_property_id, (s."startedAt" AT TIME ZONE p_tz)::date, s.platform, s."appVersion", s."locationContext",
           count(*), count(l.secs), coalesce(sum(l.secs), 0),
           count(*) FILTER (WHERE l.secs < 30),
           count(*) FILTER (WHERE l.secs >= 30 AND l.secs < 60),
           count(*) FILTER (WHERE l.secs >= 60 AND l.secs < 300),
           count(*) FILTER (WHERE l.secs >= 300 AND l.secs < 900),
           count(*) FILTER (WHERE l.secs >= 900 AND l.secs < 3600),
           count(*) FILTER (WHERE l.secs >= 3600)
      FROM pg_temp."dxSessions" s
     CROSS JOIN LATERAL (
         SELECT CASE WHEN s."endedAt" >= s."startedAt" AND s."endedAt" < s."startedAt" + interval '24 hours'
                     THEN extract(epoch FROM s."endedAt" - s."startedAt") END AS secs
     ) l
     WHERE s."startedAt" >= v_from
       AND NOT EXISTS (SELECT 1 FROM analytics."excludedUser" x
                        WHERE x."tenantId" = p_tenant_id AND x."propertyId" = p_property_id AND x."userId" = s."userId")
     GROUP BY 3, 4, 5, 6;

    DELETE FROM analytics."guestDeviceDaily"
     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" BETWEEN v_first AND v_today;
    INSERT INTO analytics."guestDeviceDaily"
        ("tenantId", "propertyId", "bucketDate", "userId", "deviceId", platform, "appVersion", model, sessions)
    SELECT p_tenant_id, p_property_id, (s."startedAt" AT TIME ZONE p_tz)::date, s."userId",
           coalesce(s."deviceId", 'unknown'), s.platform, s."appVersion", coalesce(d.model, 'unknown'), count(*)
      FROM pg_temp."dxSessions" s
      LEFT JOIN pg_temp."dxDevices" d ON d."deviceId" = s."deviceId"
     WHERE s."startedAt" >= v_from AND s."userId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM analytics."excludedUser" x
                        WHERE x."tenantId" = p_tenant_id AND x."propertyId" = p_property_id AND x."userId" = s."userId")
     GROUP BY 3, 4, 5, 6, 7, 8;

    -- App events in the window, by the platform and version of their session.
    DELETE FROM analytics."eventVersionDaily"
     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" BETWEEN v_first AND v_today;
    INSERT INTO analytics."eventVersionDaily" ("tenantId", "propertyId", "bucketDate", platform, "appVersion", "eventCount", "errorCount")
    SELECT p_tenant_id, p_property_id, (e."createdDate" AT TIME ZONE p_tz)::date,
           coalesce(s.platform, 'unknown'), coalesce(s."appVersion", 'unknown'),
           count(*), count(*) FILTER (WHERE e."eventId" = 'api_error')
      FROM data."dexAnalytics" e
      LEFT JOIN pg_temp."dxSessions" s ON s."sessionId" = e."sessionId"
     WHERE e."tenantId" = p_tenant_id AND e."propertyId" = p_property_id
       AND e."createdDate" >= v_from AND e."createdDate" < v_to
       AND NOT EXISTS (SELECT 1 FROM analytics."excludedUser" x
                        WHERE x."tenantId" = e."tenantId" AND x."propertyId" = e."propertyId" AND x."userId" = e."userId")
     GROUP BY 3, 4, 5;

    -- Outbound messages. notifiedAt is UTC without a zone.
    DELETE FROM analytics."pushDeliveryDaily"
     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" BETWEEN v_first AND v_today;
    INSERT INTO analytics."pushDeliveryDaily" ("tenantId", "propertyId", "bucketDate", "messageType", status, reason, sends)
    SELECT p_tenant_id, p_property_id, ((a."notifiedAt" AT TIME ZONE 'UTC') AT TIME ZONE p_tz)::date,
           coalesce(nullif(btrim(a.event), ''), '(none)'),
           lower(coalesce(nullif(btrim(a.status), ''), 'unknown')),
           CASE WHEN upper(btrim(a.status)) = 'FAILED' THEN analytics."normalizeReason"(a."respMsg") ELSE '' END,
           count(*)
      FROM dextrans."apnLogs" a
     WHERE a."tenantId" = p_tenant_id AND a."propertyId" = p_property_id
       AND a."notifiedAt" >= (v_from AT TIME ZONE 'UTC') AND a."notifiedAt" < (v_to AT TIME ZONE 'UTC')
     GROUP BY 3, 4, 5, 6;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_rows := v_rows + n;

    -- Campaign definitions (snapshot) and the sent-day funnel for recent sends.
    DELETE FROM analytics.campaign WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id;
    INSERT INTO analytics.campaign
        ("tenantId", "propertyId", "campaignId", name, category, status, "targetType", "scheduleType", "startDate", "endDate", "isDeleted", "isTest")
    SELECT p_tenant_id, p_property_id, m.id, coalesce(m.name, '(unnamed)'), coalesce(m.category, ''), coalesce(m.status, ''),
           coalesce(m."targetType", ''), coalesce(m."scheduleType", ''), m."startDate", m."endDate", coalesce(m."isDelete", false),
           coalesce(f."isTest", analytics."looksLikeTest"(m.name))
      FROM dextrans."campaignMaster" m
      LEFT JOIN analytics."campaignFlag" f ON f."campaignId" = m.id
     WHERE m."tenantId" = p_tenant_id AND m."propertyId" = p_property_id AND m.id IS NOT NULL;

    DELETE FROM analytics."campaignDaily"
     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" BETWEEN v_cfirst AND v_today;
    INSERT INTO analytics."campaignDaily"
        ("tenantId", "propertyId", "bucketDate", "campaignId", channel, sent, delivered, opened, clicked, converted, unsubscribed)
    SELECT p_tenant_id, p_property_id, (c."sentAt" AT TIME ZONE p_tz)::date,
           coalesce(c."campaignId", '00000000-0000-0000-0000-000000000000'::uuid),
           lower(coalesce(nullif(btrim(c.channel), ''), 'unknown')),
           count(*), count(c."deliveredAt"), count(c."openedAt"), count(c."clickedAt"), count(c."convertedAt"), count(c."unSubAt")
      FROM dextrans."campaignStats" c
     WHERE c."tenantId" = p_tenant_id AND c."propertyId" = p_property_id
       AND c."sentAt" >= v_cfrom AND c."sentAt" < v_to
     GROUP BY 3, 4, 5;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_rows := v_rows + n;

    -- Tier per account (snapshot).
    DELETE FROM analytics."accountTier" WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id;
    INSERT INTO analytics."accountTier" ("tenantId", "propertyId", "userId", tier)
    SELECT DISTINCT ON (c."userId") p_tenant_id, p_property_id, c."userId"::text, coalesce(nullif(btrim(c."clubName"), ''), '(no tier)')
      FROM dextrans.cards c
     WHERE c."tenantId" = p_tenant_id AND c."propertyId" = p_property_id AND c."userId" IS NOT NULL
     ORDER BY c."userId", c."isActive" DESC NULLS LAST, c."modifiedDate" DESC NULLS LAST;

    -- Scheduled jobs.
    DELETE FROM analytics."jobRunDaily"
     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" BETWEEN v_first AND v_today;
    INSERT INTO analytics."jobRunDaily"
        ("tenantId", "propertyId", "bucketDate", "jobName", runs, completed, failed, stuck, running,
         "durationSeconds", "durationCount", "maxDurationSeconds")
    SELECT p_tenant_id, p_property_id, (j."startTime" AT TIME ZONE p_tz)::date, coalesce(nullif(btrim(j."jobName"), ''), '(unnamed)'),
           count(*),
           count(*) FILTER (WHERE lower(j.status) = 'completed'),
           count(*) FILTER (WHERE lower(j.status) = 'failed'),
           count(*) FILTER (WHERE lower(j.status) = 'started' AND j."startTime" < now() - interval '1 hour'),
           count(*) FILTER (WHERE lower(j.status) = 'started' AND j."startTime" >= now() - interval '1 hour'),
           coalesce(sum(l.secs), 0), count(l.secs), max(l.secs)
      FROM dextrans."jobStatus" j
     CROSS JOIN LATERAL (
         SELECT CASE WHEN j."endTime" >= j."startTime" AND j."endTime" < j."startTime" + interval '1 day'
                     THEN extract(epoch FROM j."endTime" - j."startTime") END AS secs
     ) l
     WHERE j."tenantId" = p_tenant_id AND j."propertyId" = p_property_id
       AND j."startTime" >= v_from AND j."startTime" < v_to
     GROUP BY 3, 4;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_rows := v_rows + n;

    DELETE FROM analytics."jobLatest" WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id;
    INSERT INTO analytics."jobLatest" ("tenantId", "propertyId", "jobName", "isTest", "lastStartAt", "lastStatus", "lastSuccessAt", "lastFailureAt")
    SELECT p_tenant_id, p_property_id, x.name, analytics."looksLikeTest"(x.name), max(x."startTime"),
           (array_agg(x.status ORDER BY x."startTime" DESC))[1],
           max(x."startTime") FILTER (WHERE x.status = 'completed'),
           max(x."startTime") FILTER (WHERE x.status = 'failed')
      FROM (SELECT coalesce(nullif(btrim(j."jobName"), ''), '(unnamed)') AS name, j."startTime", lower(j.status) AS status
              FROM dextrans."jobStatus" j
             WHERE j."tenantId" = p_tenant_id AND j."propertyId" = p_property_id
               AND j."startTime" >= now() - interval '30 days') x
     GROUP BY x.name;

    RETURN v_rows;
END;
$$;

-- Rebuild every property's dextrans rollups; one transaction per property, so one
-- property failing (or dextrans being unreachable) is logged and the rest continue.
-- Schedule every 15 minutes; run once with large windows to backfill history.
CREATE PROCEDURE analytics."refreshDextrans"(p_days integer DEFAULT 3, p_campaign_days integer DEFAULT 45)
LANGUAGE plpgsql AS $$
DECLARE
    v_run_id bigint;
    p        record;
    v_ok     integer := 0;
    v_failed integer := 0;
    v_rows   bigint  := 0;
    v_error  text;
BEGIN
    IF p_days IS NULL OR p_days < 1 OR p_campaign_days IS NULL OR p_campaign_days < 1 THEN
        RAISE EXCEPTION 'p_days and p_campaign_days must be at least 1';
    END IF;

    INSERT INTO analytics."refreshRun" (status, kind) VALUES ('running', 'dextrans') RETURNING "runId" INTO v_run_id;
    COMMIT;

    FOR p IN SELECT "tenantId", "propertyId", "timeZone" FROM analytics.property ORDER BY "tenantId", "propertyId" LOOP
        BEGIN
            v_rows := v_rows + analytics."refreshDextransProperty"(p."tenantId", p."propertyId", p."timeZone", p_days, p_campaign_days);
            v_ok := v_ok + 1;
        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed + 1;
            v_error  := format('tenant %s property %s: %s', p."tenantId", p."propertyId", SQLERRM);
            RAISE WARNING 'dextrans refresh failed for %', v_error;
        END;
        COMMIT;
    END LOOP;

    UPDATE analytics."refreshRun"
       SET "finishedAt"    = clock_timestamp(),
           status          = CASE WHEN v_failed = 0 THEN 'succeeded' ELSE 'failed' END,
           "daysRefreshed" = v_ok * p_days,
           "daysFailed"    = v_failed * p_days,
           "eventsScanned" = v_rows,
           error           = v_error
     WHERE "runId" = v_run_id;
    COMMIT;
END;
$$;

COMMIT;
