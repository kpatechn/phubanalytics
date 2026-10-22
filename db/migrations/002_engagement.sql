-- 002_engagement.sql
-- Database: dexl. Active-account metrics (DAU/WAU/MAU, new vs returning,
-- retention, on-property active accounts) count foreground events only.
--
--   * eventCatalog."isForeground": false for events that fire without the guest
--     using the app (geofence triggers, push receipts, backgrounding, permission
--     status checks, API errors). Changing it rebuilds history.
--   * guestDaily gains foregroundEventCount and onsiteForegroundEventCount.
--     An account is active on a day when foregroundEventCount > 0.

BEGIN;

ALTER TABLE analytics."eventCatalog"
    ADD COLUMN "isForeground" boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN analytics."eventCatalog"."isForeground" IS
    'Counts as the guest using the app (DAU/WAU/MAU). False for background and system events.';

UPDATE analytics."eventCatalog" SET "isForeground" = false, "updatedAt" = now()
 WHERE "eventId" IN (
    'geofence_entered',
    'geofence_exited',
    'push_device_handled',
    'app_backgrounded',
    'session_ended',
    'api_error',
    'notification_permission_granted',
    'notification_permission_changed',
    'location_permission_granted',
    'bluetooth_permission_granted');

ALTER TABLE analytics."guestDaily"
    ADD COLUMN "foregroundEventCount"       bigint NOT NULL DEFAULT 0,
    ADD COLUMN "onsiteForegroundEventCount" bigint NOT NULL DEFAULT 0;

-- First active day per account and "came back within N days" look up one account's days.
CREATE INDEX "guestDaily_active_user_idx" ON analytics."guestDaily" ("tenantId", "propertyId", "userId", "bucketDate")
    WHERE "foregroundEventCount" > 0;

-- Rebuild every rollup for one property-local day from raw events.
-- Safe to call concurrently: callers for the same day are serialized.
-- Returns the number of raw events read.
CREATE OR REPLACE FUNCTION analytics."refreshDay"(p_tenant_id integer, p_property_id integer, p_day date)
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

    -- Foreground = a catalog event with "isForeground". Events missing from the
    -- catalog never count as activity.
    INSERT INTO analytics."guestDaily"
        ("tenantId", "propertyId", "bucketDate", "userId", "eventCount", "sessionCount",
         "onsiteEventCount", "offsiteEventCount", "foregroundEventCount", "onsiteForegroundEventCount",
         "firstEventAt", "lastEventAt")
    SELECT p_tenant_id, p_property_id, p_day, e."userId", count(*), count(DISTINCT e."sessionId"),
           count(*) FILTER (WHERE e."locationContext" = 'onsite'),
           count(*) FILTER (WHERE e."locationContext" = 'offsite'),
           count(*) FILTER (WHERE c."isForeground"),
           count(*) FILTER (WHERE c."isForeground" AND e."locationContext" = 'onsite'),
           min(e."createdDate"), max(e."createdDate")
      FROM pg_temp."refreshDayEvents" e
      LEFT JOIN analytics."eventCatalog" c ON c."eventId" = e."eventId"
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

-- Catalog changes that move an event in or out of "foreground" rebuild history.
CREATE TRIGGER "eventCatalog_queue_history"
    AFTER INSERT OR DELETE OR UPDATE OF "isForeground" ON analytics."eventCatalog"
    FOR EACH STATEMENT EXECUTE FUNCTION analytics."queueAllProperties"();

-- Fill the new columns for existing history.
SELECT analytics."markDirty"(p."tenantId", p."propertyId") FROM analytics.property p;

COMMIT;
