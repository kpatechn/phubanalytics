-- 001_analytics_rollups.sql
-- Database: dexl. Replaces the first-generation rollups in schema analytics.
--
-- Old design: insert trigger copied every event into a delta table; a function
-- added delta counts into rollups bucketed by UTC day. Nothing scheduled it.
--
-- New design:
--   * Every rollup is bucketed by the property's local day (analytics.property."timeZone").
--   * Inserts, updates and deletes on data."dexAnalytics" queue the affected UTC hours
--     (append-only, so ingest never waits on a lock and never fails because of analytics).
--   * analytics."refreshRollups"() rebuilds each affected local day from raw events:
--     delete + insert in one transaction, so re-runs are idempotent and late events,
--     deletions (privacy) and exclusions are picked up.
--   * Breakdowns by attribute are configuration (analytics."dimensionRule"), not code.
--
-- Rollups are derived data. Inserting a row into analytics.property queues that
-- property's full history; then CALL analytics."refreshRollups"().

BEGIN;

-- 1. Remove the first-generation pipeline --------------------------------------

DROP TRIGGER IF EXISTS "dexAnalytics_delta_after_insert" ON data."dexAnalytics";
DROP PROCEDURE IF EXISTS analytics."backfillMobAnalyticsHistory"(timestamptz, timestamptz, interval, integer);
DROP FUNCTION IF EXISTS analytics."processMobAnalyticsIngestDelta"(integer);
DROP FUNCTION IF EXISTS analytics."captureDexAnalyticsInsertDelta"();
DROP TABLE IF EXISTS
    analytics."mobAnalyticsIngestDelta",
    analytics."mobAnalyticsBackfillRange",
    analytics."eventDaily",
    analytics."eventHourly",
    analytics."eventDimensionDaily",
    analytics."apiErrorEndpointDaily",
    analytics."apiErrorMessageDaily",
    analytics."userEventDaily";

CREATE SCHEMA IF NOT EXISTS analytics;

-- 2. Configuration -------------------------------------------------------------

CREATE FUNCTION analytics."isTimeZone"(p_name text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_name)
$$;

-- One row per property whose events are rolled up. The time zone sets the
-- business-day boundary for every rollup of that property.
CREATE TABLE analytics.property (
    "tenantId"    integer     NOT NULL,
    "propertyId"  integer     NOT NULL,
    name          text        NOT NULL,
    "timeZone"    text        NOT NULL CHECK (analytics."isTimeZone"("timeZone")),
    environment   text        NOT NULL CHECK (environment IN ('prod', 'staging', 'dev')),
    "createdAt"   timestamptz NOT NULL DEFAULT now(),
    "updatedAt"   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId")
);

-- Event names as the app sends them, with display names for the UI and the
-- feature each one counts toward. Read at query time; changes need no rebuild.
CREATE TABLE analytics."eventCatalog" (
    "eventId"     varchar(150) PRIMARY KEY,
    "displayName" text         NOT NULL,
    category      text         NOT NULL,
    feature       text,                       -- NULL: not counted in feature usage
    description   text,
    "isActive"    boolean      NOT NULL DEFAULT true,
    "createdAt"   timestamptz  NOT NULL DEFAULT now(),
    "updatedAt"   timestamptz  NOT NULL DEFAULT now()
);

-- Which attribute of which event becomes a breakdown in eventDimensionDaily.
-- "sourceKey" is an attributes key, or @mobileName for that column.
-- "numericKey" (optional) is summed into numericValueSum, e.g. time_spent_ms.
-- Changing rules rebuilds every property's history (trigger below).
CREATE TABLE analytics."dimensionRule" (
    "eventId"       varchar(150) NOT NULL,
    "dimensionType" varchar(50)  NOT NULL,
    "sourceKey"     text         NOT NULL,
    "numericKey"    text,
    "maxLength"     integer      NOT NULL DEFAULT 200 CHECK ("maxLength" BETWEEN 1 AND 500),
    "isActive"      boolean      NOT NULL DEFAULT true,
    PRIMARY KEY ("eventId", "dimensionType")
);

-- Staff and test accounts left out of every rollup. Adding or removing a row
-- rebuilds the days that account has events on.
CREATE TABLE analytics."excludedUser" (
    "tenantId"   integer     NOT NULL,
    "propertyId" integer     NOT NULL,
    "userId"     varchar(36) NOT NULL,
    reason       text        NOT NULL,
    "createdAt"  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "userId")
);

-- Display names for geofence IDs, and which zones are tests. Read at query time.
CREATE TABLE analytics."geofenceZone" (
    "tenantId"    integer      NOT NULL,
    "propertyId"  integer      NOT NULL,
    "geofenceId"  varchar(150) NOT NULL,
    "displayName" text         NOT NULL,
    "isTest"      boolean      NOT NULL DEFAULT false,
    PRIMARY KEY ("tenantId", "propertyId", "geofenceId")
);

-- 3. Rollups (all days are property-local) ---------------------------------------

-- locationContext is normalized to onsite | offsite | unknown.
CREATE TABLE analytics."eventDaily" (
    "tenantId"        integer      NOT NULL,
    "propertyId"      integer      NOT NULL,
    "bucketDate"      date         NOT NULL,
    "eventId"         varchar(150) NOT NULL,
    "locationContext" varchar(10)  NOT NULL,
    "eventCount"      bigint       NOT NULL,
    "refreshedAt"     timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "eventId", "locationContext")
);

-- Local wall-clock hour. On the autumn DST change both 01:00 hours land in hourOfDay 1.
CREATE TABLE analytics."eventHourly" (
    "tenantId"        integer      NOT NULL,
    "propertyId"      integer      NOT NULL,
    "bucketDate"      date         NOT NULL,
    "hourOfDay"       smallint     NOT NULL CHECK ("hourOfDay" BETWEEN 0 AND 23),
    "eventId"         varchar(150) NOT NULL,
    "locationContext" varchar(10)  NOT NULL,
    "eventCount"      bigint       NOT NULL,
    "refreshedAt"     timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "hourOfDay", "eventId", "locationContext")
);

-- One row per dimensionRule value per day. Missing values are '(none)'.
-- Average of the numeric attribute = numericValueSum / numericValueCount.
CREATE TABLE analytics."eventDimensionDaily" (
    "tenantId"          integer      NOT NULL,
    "propertyId"        integer      NOT NULL,
    "bucketDate"        date         NOT NULL,
    "eventId"           varchar(150) NOT NULL,
    "dimensionType"     varchar(50)  NOT NULL,
    "dimensionValue"    text         NOT NULL,
    "eventCount"        bigint       NOT NULL,
    "numericValueSum"   numeric      NOT NULL,
    "numericValueCount" bigint       NOT NULL,
    "refreshedAt"       timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "eventId", "dimensionType", "dimensionValue")
);

-- api_error events. endpoint and message are normalized (see functions below).
CREATE TABLE analytics."apiErrorDaily" (
    "tenantId"    integer     NOT NULL,
    "propertyId"  integer     NOT NULL,
    "bucketDate"  date        NOT NULL,
    endpoint      text        NOT NULL,
    method        text        NOT NULL,
    "statusCode"  text        NOT NULL,
    "errorType"   text        NOT NULL,
    "errorCode"   text        NOT NULL,
    message       text        NOT NULL,
    "eventCount"  bigint      NOT NULL,
    "refreshedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", endpoint, method, "statusCode", "errorType", "errorCode", message)
);

-- Guest-level tables: one row per account per day (and per event). They hold
-- account IDs, so grant them only to the API role, never to dashboards directly.
-- They answer distinct-guest questions over any range (DAU/MAU, retention,
-- feature reach) without scanning raw events.
CREATE TABLE analytics."guestDaily" (
    "tenantId"          integer     NOT NULL,
    "propertyId"        integer     NOT NULL,
    "bucketDate"        date        NOT NULL,
    "userId"            varchar(36) NOT NULL,
    "eventCount"        bigint      NOT NULL,
    "sessionCount"      integer     NOT NULL,
    "onsiteEventCount"  bigint      NOT NULL,
    "offsiteEventCount" bigint      NOT NULL,
    "firstEventAt"      timestamptz NOT NULL,
    "lastEventAt"       timestamptz NOT NULL,
    "refreshedAt"       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "userId")
);

CREATE TABLE analytics."guestEventDaily" (
    "tenantId"    integer      NOT NULL,
    "propertyId"  integer      NOT NULL,
    "bucketDate"  date         NOT NULL,
    "userId"      varchar(36)  NOT NULL,
    "eventId"     varchar(150) NOT NULL,
    "eventCount"  bigint       NOT NULL,
    "refreshedAt" timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenantId", "propertyId", "bucketDate", "userId", "eventId")
);

-- 4. Refresh bookkeeping -------------------------------------------------------

-- Append-only: one row per (statement, UTC hour) touched. Never updated, so
-- concurrent ingest batches never contend. refreshRollups deletes exactly the
-- rows it saw, so a mark that commits mid-refresh is kept for the next run.
CREATE TABLE analytics."refreshQueue" (
    "queueId"    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "tenantId"   integer     NOT NULL,
    "propertyId" integer     NOT NULL,
    "bucketHour" timestamptz NOT NULL,     -- start of a UTC hour
    "queuedAt"   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics."refreshRun" (
    "runId"         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "startedAt"     timestamptz NOT NULL DEFAULT clock_timestamp(),
    "finishedAt"    timestamptz,
    status          varchar(20) NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    "daysRefreshed" integer,
    "daysFailed"    integer,
    "eventsScanned" bigint,
    "queueCleared"  integer,
    error           text
);

-- 5. Normalizers (shared by refresh and by ad-hoc queries) -------------------

-- '/mobile/v2/marker/balance/123?x=1' -> 'marker/balance/{id}'
CREATE FUNCTION analytics."normalizeEndpoint"(p_endpoint text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT coalesce(nullif(
        regexp_replace(
            regexp_replace(
                regexp_replace(split_part(split_part(btrim(coalesce(p_endpoint, '')), '?', 1), '#', 1),
                               '^https?://[^/]+', ''),
                '^/mobile/v[0-9]+/', ''),
            '/([0-9]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?=/|$)',
            '/{id}', 'g'),
        ''), 'unknown')
$$;

-- First line, credentials in query strings redacted, IDs and long numbers
-- collapsed so similar messages group together, 200 characters max.
CREATE FUNCTION analytics."normalizeErrorMessage"(p_message text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT coalesce(nullif(left(
        regexp_replace(
            regexp_replace(
                regexp_replace(split_part(btrim(coalesce(p_message, '')), E'\n', 1),
                               '([?&](sessionId|token|access_token|auth|password|playerId)=)[^&[:space:]''"]*', '\1{redacted}', 'gi'),
                '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '{uuid}', 'g'),
            '[0-9]{6,}', '{n}', 'g'),
        200), ''), 'Unknown error message')
$$;

-- Dimension value: first line, trimmed, capped. Empty, NA and missing -> '(none)'.
CREATE FUNCTION analytics."dimensionText"(p_value text, p_max_length integer) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN v IS NULL OR v IN ('', 'NA', 'null') THEN '(none)' ELSE v END
    FROM (SELECT left(btrim(split_part(btrim(p_value), E'\n', 1)), p_max_length) AS v) x
$$;

-- 6. Queueing ------------------------------------------------------------------

-- Queue every UTC hour in [p_from, p_to] for a property. With no range, the
-- property's whole event history. Returns the number of hours queued.
CREATE FUNCTION analytics."markDirty"(
    p_tenant_id integer, p_property_id integer,
    p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    v_from  timestamptz := p_from;
    v_to    timestamptz := p_to;
    v_count integer;
BEGIN
    IF v_from IS NULL OR v_to IS NULL THEN
        SELECT coalesce(v_from, min(e."createdDate")), coalesce(v_to, max(e."createdDate"))
          INTO v_from, v_to
          FROM data."dexAnalytics" e
         WHERE e."tenantId" = p_tenant_id AND e."propertyId" = p_property_id;
    END IF;
    IF v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN
        RETURN 0;
    END IF;

    INSERT INTO analytics."refreshQueue" ("tenantId", "propertyId", "bucketHour")
    SELECT p_tenant_id, p_property_id, h
      FROM generate_series(date_trunc('hour', v_from, 'UTC'), v_to, interval '1 hour') h;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Statement trigger on data."dexAnalytics". Errors are downgraded to warnings:
-- analytics must never block event ingestion.
CREATE FUNCTION analytics."queueChangedEvents"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, analytics AS $$
BEGIN
    BEGIN
        IF TG_OP = 'INSERT' THEN
            INSERT INTO analytics."refreshQueue" ("tenantId", "propertyId", "bucketHour")
            SELECT DISTINCT n."tenantId", n."propertyId", date_trunc('hour', n."createdDate", 'UTC')
              FROM new_rows n;
        ELSIF TG_OP = 'UPDATE' THEN
            INSERT INTO analytics."refreshQueue" ("tenantId", "propertyId", "bucketHour")
            SELECT "tenantId", "propertyId", date_trunc('hour', "createdDate", 'UTC') FROM new_rows
             UNION
            SELECT "tenantId", "propertyId", date_trunc('hour', "createdDate", 'UTC') FROM old_rows;
        ELSE
            INSERT INTO analytics."refreshQueue" ("tenantId", "propertyId", "bucketHour")
            SELECT DISTINCT o."tenantId", o."propertyId", date_trunc('hour', o."createdDate", 'UTC')
              FROM old_rows o;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'analytics refresh queue not updated (% on data."dexAnalytics"): %', TG_OP, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "dexAnalytics_queue_insert" AFTER INSERT ON data."dexAnalytics"
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION analytics."queueChangedEvents"();
CREATE TRIGGER "dexAnalytics_queue_update" AFTER UPDATE ON data."dexAnalytics"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION analytics."queueChangedEvents"();
CREATE TRIGGER "dexAnalytics_queue_delete" AFTER DELETE ON data."dexAnalytics"
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION analytics."queueChangedEvents"();

-- New property: queue its history. Time zone change: clear its rollups, then
-- queue its history so every day is rebuilt on the new boundaries.
CREATE FUNCTION analytics."queuePropertyHistory"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."timeZone" IS NOT DISTINCT FROM OLD."timeZone" THEN
            RETURN NULL;
        END IF;
        DELETE FROM analytics."eventDaily"          WHERE "tenantId" = NEW."tenantId" AND "propertyId" = NEW."propertyId";
        DELETE FROM analytics."eventHourly"         WHERE "tenantId" = NEW."tenantId" AND "propertyId" = NEW."propertyId";
        DELETE FROM analytics."eventDimensionDaily" WHERE "tenantId" = NEW."tenantId" AND "propertyId" = NEW."propertyId";
        DELETE FROM analytics."apiErrorDaily"       WHERE "tenantId" = NEW."tenantId" AND "propertyId" = NEW."propertyId";
        DELETE FROM analytics."guestDaily"          WHERE "tenantId" = NEW."tenantId" AND "propertyId" = NEW."propertyId";
        DELETE FROM analytics."guestEventDaily"     WHERE "tenantId" = NEW."tenantId" AND "propertyId" = NEW."propertyId";
    END IF;
    PERFORM analytics."markDirty"(NEW."tenantId", NEW."propertyId");
    RETURN NULL;
END;
$$;

CREATE TRIGGER "property_queue_history" AFTER INSERT OR UPDATE OF "timeZone" ON analytics.property
    FOR EACH ROW EXECUTE FUNCTION analytics."queuePropertyHistory"();

CREATE FUNCTION analytics."queueAllProperties"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM analytics."markDirty"(p."tenantId", p."propertyId") FROM analytics.property p;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "dimensionRule_queue_history" AFTER INSERT OR UPDATE OR DELETE ON analytics."dimensionRule"
    FOR EACH STATEMENT EXECUTE FUNCTION analytics."queueAllProperties"();

-- Exclusion added or removed: queue the hours that account has events in.
-- Scans raw events by userId (no index); exclusions are rare admin changes.
CREATE FUNCTION analytics."queueExcludedUser"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    r analytics."excludedUser";
BEGIN
    IF TG_OP = 'DELETE' THEN
        r := OLD;
    ELSE
        r := NEW;
    END IF;
    INSERT INTO analytics."refreshQueue" ("tenantId", "propertyId", "bucketHour")
    SELECT DISTINCT e."tenantId", e."propertyId", date_trunc('hour', e."createdDate", 'UTC')
      FROM data."dexAnalytics" e
     WHERE e."tenantId" = r."tenantId" AND e."propertyId" = r."propertyId" AND e."userId" = r."userId";
    RETURN NULL;
END;
$$;

CREATE TRIGGER "excludedUser_queue_history" AFTER INSERT OR DELETE ON analytics."excludedUser"
    FOR EACH ROW EXECUTE FUNCTION analytics."queueExcludedUser"();

-- 7. Refresh -------------------------------------------------------------------

-- Rebuild every rollup for one property-local day from raw events.
-- Safe to call concurrently: callers for the same day are serialized.
-- Returns the number of raw events read.
CREATE FUNCTION analytics."refreshDay"(p_tenant_id integer, p_property_id integer, p_day date)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_tz     text;
    v_from   timestamptz;
    v_to     timestamptz;
    v_events bigint;
BEGIN
    SELECT p."timeZone" INTO v_tz
      FROM analytics.property p
     WHERE p."tenantId" = p_tenant_id AND p."propertyId" = p_property_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'analytics.property has no row for tenant % property %', p_tenant_id, p_property_id;
    END IF;

    v_from := p_day::timestamp AT TIME ZONE v_tz;
    v_to   := (p_day + 1)::timestamp AT TIME ZONE v_tz;

    PERFORM pg_advisory_xact_lock(hashtextextended(format('analytics.refreshDay:%s:%s:%s', p_tenant_id, p_property_id, p_day), 0));

    CREATE TEMP TABLE IF NOT EXISTS "refreshDayEvents" (
        "createdDate"     timestamptz,
        "localTime"       timestamp,
        "eventId"         varchar(150),
        "locationContext" varchar(10),
        "userId"          varchar(36),
        "sessionId"       uuid,
        "mobileName"      varchar(50),
        attributes        jsonb
    ) ON COMMIT DROP;
    TRUNCATE pg_temp."refreshDayEvents";

    INSERT INTO pg_temp."refreshDayEvents"
    SELECT e."createdDate",
           e."createdDate" AT TIME ZONE v_tz,
           e."eventId",
           CASE lower(btrim(e."locationContext")) WHEN 'onsite' THEN 'onsite' WHEN 'offsite' THEN 'offsite' ELSE 'unknown' END,
           nullif(btrim(e."userId"), ''),
           e."sessionId",
           e."mobileName",
           CASE WHEN jsonb_typeof(e.attributes) = 'object' THEN e.attributes ELSE '{}'::jsonb END
      FROM data."dexAnalytics" e
     WHERE e."createdDate" >= v_from AND e."createdDate" < v_to
       AND e."tenantId" = p_tenant_id AND e."propertyId" = p_property_id
       AND NOT EXISTS (
           SELECT 1 FROM analytics."excludedUser" x
            WHERE x."tenantId" = e."tenantId" AND x."propertyId" = e."propertyId" AND x."userId" = e."userId");
    GET DIAGNOSTICS v_events = ROW_COUNT;

    DELETE FROM analytics."eventDaily"          WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" = p_day;
    DELETE FROM analytics."eventHourly"         WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" = p_day;
    DELETE FROM analytics."eventDimensionDaily" WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" = p_day;
    DELETE FROM analytics."apiErrorDaily"       WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" = p_day;
    DELETE FROM analytics."guestDaily"          WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" = p_day;
    DELETE FROM analytics."guestEventDaily"     WHERE "tenantId" = p_tenant_id AND "propertyId" = p_property_id AND "bucketDate" = p_day;

    IF v_events = 0 THEN
        RETURN 0;
    END IF;

    INSERT INTO analytics."eventDaily" ("tenantId", "propertyId", "bucketDate", "eventId", "locationContext", "eventCount")
    SELECT p_tenant_id, p_property_id, p_day, e."eventId", e."locationContext", count(*)
      FROM pg_temp."refreshDayEvents" e
     GROUP BY e."eventId", e."locationContext";

    INSERT INTO analytics."eventHourly" ("tenantId", "propertyId", "bucketDate", "hourOfDay", "eventId", "locationContext", "eventCount")
    SELECT p_tenant_id, p_property_id, p_day, extract(hour FROM e."localTime")::smallint, e."eventId", e."locationContext", count(*)
      FROM pg_temp."refreshDayEvents" e
     GROUP BY 4, e."eventId", e."locationContext";

    INSERT INTO analytics."eventDimensionDaily"
        ("tenantId", "propertyId", "bucketDate", "eventId", "dimensionType", "dimensionValue",
         "eventCount", "numericValueSum", "numericValueCount")
    SELECT p_tenant_id, p_property_id, p_day, e."eventId", r."dimensionType",
           analytics."dimensionText"(
               CASE r."sourceKey" WHEN '@mobileName' THEN e."mobileName" ELSE e.attributes ->> r."sourceKey" END,
               r."maxLength"),
           count(*),
           coalesce(sum(n.val), 0),
           count(n.val)
      FROM pg_temp."refreshDayEvents" e
      JOIN analytics."dimensionRule" r ON r."eventId" = e."eventId" AND r."isActive"
      CROSS JOIN LATERAL (
          SELECT CASE WHEN e.attributes ->> r."numericKey" ~ '^-?[0-9]+(\.[0-9]+)?$'
                      THEN (e.attributes ->> r."numericKey")::numeric END AS val
      ) n
     GROUP BY e."eventId", r."dimensionType", 6;

    INSERT INTO analytics."apiErrorDaily"
        ("tenantId", "propertyId", "bucketDate", endpoint, method, "statusCode", "errorType", "errorCode", message, "eventCount")
    SELECT p_tenant_id, p_property_id, p_day,
           analytics."normalizeEndpoint"(e.attributes ->> 'endpoint'),
           coalesce(nullif(upper(btrim(e.attributes ->> 'method')), ''), 'UNKNOWN'),
           coalesce(nullif(btrim(e.attributes ->> 'status_code'), ''), 'unknown'),
           coalesce(nullif(btrim(e.attributes ->> 'error_type'), ''), 'unknown'),
           coalesce(nullif(btrim(coalesce(e.attributes ->> 'error_code', e.attributes ->> 'errorCode')), ''), 'unknown'),
           analytics."normalizeErrorMessage"(e.attributes ->> 'error_message'),
           count(*)
      FROM pg_temp."refreshDayEvents" e
     WHERE e."eventId" = 'api_error'
     GROUP BY 4, 5, 6, 7, 8, 9;

    INSERT INTO analytics."guestDaily"
        ("tenantId", "propertyId", "bucketDate", "userId", "eventCount", "sessionCount",
         "onsiteEventCount", "offsiteEventCount", "firstEventAt", "lastEventAt")
    SELECT p_tenant_id, p_property_id, p_day, e."userId", count(*), count(DISTINCT e."sessionId"),
           count(*) FILTER (WHERE e."locationContext" = 'onsite'),
           count(*) FILTER (WHERE e."locationContext" = 'offsite'),
           min(e."createdDate"), max(e."createdDate")
      FROM pg_temp."refreshDayEvents" e
     WHERE e."userId" IS NOT NULL
     GROUP BY e."userId";

    INSERT INTO analytics."guestEventDaily" ("tenantId", "propertyId", "bucketDate", "userId", "eventId", "eventCount")
    SELECT p_tenant_id, p_property_id, p_day, e."userId", e."eventId", count(*)
      FROM pg_temp."refreshDayEvents" e
     WHERE e."userId" IS NOT NULL
     GROUP BY e."userId", e."eventId";

    RETURN v_events;
END;
$$;

-- Rebuild every local day touched by queued hours, newest day first, one
-- transaction per day. A failed day is logged and stays queued. Call it on a
-- schedule (every few minutes); p_max_days caps the work per call.
-- Must be called outside an explicit transaction (it commits per day).
CREATE PROCEDURE analytics."refreshRollups"(p_max_days integer DEFAULT 400)
LANGUAGE plpgsql AS $$
DECLARE
    v_run_id  bigint;
    d         record;
    v_ok      integer := 0;
    v_failed  integer := 0;
    v_events  bigint  := 0;
    v_cleared integer := 0;
    v_unknown integer;
    v_error   text;
BEGIN
    IF p_max_days IS NULL OR p_max_days < 1 THEN
        RAISE EXCEPTION 'p_max_days must be at least 1';
    END IF;

    INSERT INTO analytics."refreshRun" (status) VALUES ('running') RETURNING "runId" INTO v_run_id;
    COMMIT;

    -- Snapshot of the queue. Each UTC hour maps to the local day(s) it overlaps.
    IF to_regclass('pg_temp."refreshHours"') IS NOT NULL THEN
        DROP TABLE pg_temp."refreshHours";
    END IF;
    IF to_regclass('pg_temp."refreshDays"') IS NOT NULL THEN
        DROP TABLE pg_temp."refreshDays";
    END IF;
    CREATE TEMP TABLE "refreshHours" AS
    SELECT q."queueId", q."tenantId", q."propertyId", ld."bucketDate"
      FROM analytics."refreshQueue" q
      JOIN analytics.property p ON p."tenantId" = q."tenantId" AND p."propertyId" = q."propertyId"
     CROSS JOIN LATERAL (
         SELECT DISTINCT x::date AS "bucketDate"
           FROM (VALUES (q."bucketHour" AT TIME ZONE p."timeZone"),
                        ((q."bucketHour" + interval '1 hour' - interval '1 microsecond') AT TIME ZONE p."timeZone")) v(x)
     ) ld;

    CREATE TEMP TABLE "refreshDays" AS
    SELECT x."tenantId", x."propertyId", x."bucketDate", NULL::boolean AS ok
      FROM (SELECT DISTINCT "tenantId", "propertyId", "bucketDate" FROM pg_temp."refreshHours") x
     ORDER BY x."bucketDate" DESC, x."tenantId", x."propertyId"
     LIMIT p_max_days;

    FOR d IN SELECT "tenantId", "propertyId", "bucketDate" FROM pg_temp."refreshDays" ORDER BY "bucketDate" DESC LOOP
        BEGIN
            v_events := v_events + analytics."refreshDay"(d."tenantId", d."propertyId", d."bucketDate");
            UPDATE pg_temp."refreshDays" SET ok = true
             WHERE "tenantId" = d."tenantId" AND "propertyId" = d."propertyId" AND "bucketDate" = d."bucketDate";
            v_ok := v_ok + 1;
        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed + 1;
            v_error  := format('%s tenant %s property %s: %s', d."bucketDate", d."tenantId", d."propertyId", SQLERRM);
            RAISE WARNING 'analytics refresh failed for %', v_error;
            UPDATE pg_temp."refreshDays" SET ok = false
             WHERE "tenantId" = d."tenantId" AND "propertyId" = d."propertyId" AND "bucketDate" = d."bucketDate";
        END;
        COMMIT;
    END LOOP;

    -- Clear only the queue rows we saw whose every local day was rebuilt.
    WITH done AS (
        SELECT h."queueId"
          FROM pg_temp."refreshHours" h
          LEFT JOIN pg_temp."refreshDays" rd
            ON rd."tenantId" = h."tenantId" AND rd."propertyId" = h."propertyId" AND rd."bucketDate" = h."bucketDate"
         GROUP BY h."queueId"
        HAVING bool_and(coalesce(rd.ok, false))
    )
    DELETE FROM analytics."refreshQueue" q USING done WHERE q."queueId" = done."queueId";
    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    SELECT count(*) INTO v_unknown
      FROM analytics."refreshQueue" q
     WHERE NOT EXISTS (SELECT 1 FROM analytics.property p
                        WHERE p."tenantId" = q."tenantId" AND p."propertyId" = q."propertyId");
    IF v_unknown > 0 THEN
        RAISE WARNING '% queued hours belong to properties missing from analytics.property', v_unknown;
    END IF;

    UPDATE analytics."refreshRun"
       SET "finishedAt"    = clock_timestamp(),
           status          = CASE WHEN v_failed = 0 THEN 'succeeded' ELSE 'failed' END,
           "daysRefreshed" = v_ok,
           "daysFailed"    = v_failed,
           "eventsScanned" = v_events,
           "queueCleared"  = v_cleared,
           error           = v_error
     WHERE "runId" = v_run_id;
    DROP TABLE pg_temp."refreshHours";
    DROP TABLE pg_temp."refreshDays";
    COMMIT;
END;
$$;

-- 8. Health ------------------------------------------------------------------

-- For /readyz and the "data as of" banner.
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

COMMIT;
