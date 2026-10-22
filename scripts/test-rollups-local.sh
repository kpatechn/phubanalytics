#!/usr/bin/env bash
# Tests a fresh install of db/migrations/*.sql on a throwaway local database:
# copies the dev raw events table (definition only) and a scrubbed copy of its
# events, applies every migration and seed, rebuilds, runs db/tests/rollup_checks.sql, then checks
# idempotency, late events, deletes, DST, exclusions, a failing queue and
# concurrent refreshes. The dev database is only read.
#
# Usage: scripts/test-rollups-local.sh            (KEEP_DB=1 keeps the local database)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${DEV_CONN:-service=graton-dev dbname=dexl}"
LOCAL_HOST="${LOCAL_HOST:-localhost}"
LOCAL_PORT="${LOCAL_PORT:-5432}"
TEST_DB="${TEST_DB:-phub_analytics_test}"
LOCAL="host=$LOCAL_HOST port=$LOCAL_PORT dbname=$TEST_DB"

WORK="$(mktemp -d)"
cleanup() {
    rm -rf "$WORK"
    if [[ "${KEEP_DB:-0}" != "1" ]]; then
        dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists "$TEST_DB" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

dev() { PGOPTIONS='-c default_transaction_read_only=on' psql "$DEV" -X -w -v ON_ERROR_STOP=1 -q "$@"; }
loc() { psql "$LOCAL" -X -w -v ON_ERROR_STOP=1 -q "$@"; }
step() { printf '\n== %s\n' "$*"; }

ROLLUP_HASH="SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT 'd' || row(\"tenantId\", \"propertyId\", \"bucketDate\", \"eventId\", \"locationContext\", \"eventCount\")::text AS x FROM analytics.\"eventDaily\"
    UNION ALL SELECT 'h' || row(\"tenantId\", \"propertyId\", \"bucketDate\", \"hourOfDay\", \"eventId\", \"locationContext\", \"eventCount\")::text FROM analytics.\"eventHourly\"
    UNION ALL SELECT 'x' || row(\"tenantId\", \"propertyId\", \"bucketDate\", \"eventId\", \"dimensionType\", \"dimensionValue\", \"eventCount\", \"numericValueSum\", \"numericValueCount\")::text FROM analytics.\"eventDimensionDaily\"
    UNION ALL SELECT 'e' || row(\"tenantId\", \"propertyId\", \"bucketDate\", endpoint, method, \"statusCode\", \"errorType\", \"errorCode\", message, \"eventCount\")::text FROM analytics.\"apiErrorDaily\"
    UNION ALL SELECT 'g' || row(\"tenantId\", \"propertyId\", \"bucketDate\", \"userId\", \"eventCount\", \"sessionCount\", \"onsiteEventCount\", \"offsiteEventCount\", \"foregroundEventCount\", \"onsiteForegroundEventCount\", \"firstEventAt\", \"lastEventAt\")::text FROM analytics.\"guestDaily\"
    UNION ALL SELECT 'u' || row(\"tenantId\", \"propertyId\", \"bucketDate\", \"userId\", \"eventId\", \"eventCount\")::text FROM analytics.\"guestEventDaily\"
) s"
rollup_hash() { loc -At -c "$ROLLUP_HASH"; }
refresh() { loc -c 'CALL analytics."refreshRollups"()'; }
assert() { # assert "<description>" "<sql returning true>"
    local ok; ok="$(loc -At -c "SELECT ($2)::boolean")"
    if [[ "$ok" == "t" ]]; then echo "PASS  $1"; else echo "FAIL  $1"; exit 1; fi
}
run_checks() {
    loc -P pager=off -f "$ROOT/db/tests/rollup_checks.sql" | tee "$WORK/checks.txt"
    if grep -q 'FAIL' "$WORK/checks.txt"; then echo "rollup_checks.sql has failures"; exit 1; fi
}

step "Create local database $TEST_DB"
dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists "$TEST_DB"
createdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" "$TEST_DB"
loc -c "SELECT version()" -At

step "Copy the dev raw events table definition (the migrations create everything else)"
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$DEV" -w --schema-only --no-owner --no-privileges -t 'data."dexAnalytics"' \
    | grep -vE '^\\(un)?restrict ' | grep -v '^CREATE TRIGGER' > "$WORK/table.sql"
loc -c 'CREATE SCHEMA data'
loc -f "$WORK/table.sql" >/dev/null

step "Copy dev events, scrubbed (no URL query strings, account numbers, coordinates or raw payloads)"
dev -c "COPY (
    SELECT id, \"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"mobileName\", \"locationContext\",
           CASE WHEN jsonb_typeof(attributes) = 'object' THEN
                (attributes - 'account_number')
                || CASE WHEN attributes ? 'url' THEN jsonb_build_object('url', split_part(attributes->>'url', '?', 1)) ELSE '{}'::jsonb END
                || CASE WHEN attributes ? 'error_message' THEN jsonb_build_object('error_message',
                       regexp_replace(attributes->>'error_message', '([?&](sessionId|token|access_token|auth|password|playerId)=)[^&[:space:]]*', '\\1{redacted}', 'gi'))
                   ELSE '{}'::jsonb END
           ELSE attributes END,
           \"createdDate\"
      FROM data.\"dexAnalytics\") TO STDOUT WITH (FORMAT csv)" > "$WORK/events.csv"
loc -c "COPY data.\"dexAnalytics\" (id, \"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"mobileName\", \"locationContext\", attributes, \"createdDate\") FROM STDIN WITH (FORMAT csv)" < "$WORK/events.csv"
rm -f "$WORK/events.csv"
loc -At -c "SELECT count(*) || ' events copied' FROM data.\"dexAnalytics\""

step "Apply migrations and seeds"
for migration in "$ROOT"/db/migrations/*.sql; do
    echo "  $(basename "$migration")"
    loc -f "$migration"
done
loc -f "$ROOT/db/seeds/001_event_catalog.sql"
loc -f "$ROOT/db/seeds/graton_dev_property.sql"
loc -At -c "SELECT count(*) || ' hours queued' FROM analytics.\"refreshQueue\""

step "Rebuild all history"
START=$(date +%s)
refresh
echo "refreshRollups took $(( $(date +%s) - START ))s"
loc -P pager=off -c 'SELECT status, "daysRefreshed", "daysFailed", "eventsScanned", "queueCleared" FROM analytics."refreshRun" ORDER BY "runId" DESC LIMIT 1'

step "Golden values and invariants"
run_checks

step "Behaviour"
BASE="$(rollup_hash)"

# Idempotent: queue everything again and rebuild.
loc -At -c 'SELECT analytics."markDirty"(15001, 1500001)' >/dev/null
refresh
assert "Rebuilding all history gives identical rollups" "'$(rollup_hash)' = '$BASE'"

# A second refresh with nothing queued changes nothing.
refresh
assert "Refresh with an empty queue changes nothing" "'$(rollup_hash)' = '$BASE'"

# Late event for an old day is picked up; deleting it restores the day.
loc -c "INSERT INTO data.\"dexAnalytics\" (\"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"locationContext\", attributes, \"createdDate\")
        VALUES (1500001, 15001, gen_random_uuid(), 'late-test-user', 'app_opened', 'onsite', '{}', '2026-09-10 12:00 America/Los_Angeles')"
refresh
assert "Late event lands on its Pacific day" \
    "(SELECT \"eventCount\" FROM analytics.\"guestEventDaily\" WHERE \"userId\" = 'late-test-user' AND \"bucketDate\" = '2026-09-10' AND \"eventId\" = 'app_opened') = 1"
loc -c "DELETE FROM data.\"dexAnalytics\" WHERE \"userId\" = 'late-test-user'"
refresh
assert "Deleting the event restores the rollups" "'$(rollup_hash)' = '$BASE'"

# DST: US clocks fall back 2026-11-01 02:00 PDT -> 01:00 PST.
loc -c "INSERT INTO data.\"dexAnalytics\" (\"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"locationContext\", attributes, \"createdDate\")
        SELECT 1500001, 15001, gen_random_uuid(), 'dst-test-user', 'dst_test', 'offsite', '{}', t::timestamptz
          FROM unnest(ARRAY['2026-10-31 23:30-07', '2026-11-01 00:30-07', '2026-11-01 01:30-07', '2026-11-01 01:30-08', '2026-11-01 23:30-08']) t"
refresh
assert "DST: 23:30 PDT on Oct 31 stays on Oct 31" \
    "(SELECT sum(\"eventCount\") FROM analytics.\"eventDaily\" WHERE \"eventId\" = 'dst_test' AND \"bucketDate\" = '2026-10-31') = 1"
assert "DST: Nov 1 (25-hour day) has 4 events" \
    "(SELECT sum(\"eventCount\") FROM analytics.\"eventDaily\" WHERE \"eventId\" = 'dst_test' AND \"bucketDate\" = '2026-11-01') = 4"
assert "DST: both 01:30s land in hour 1, 23:30 PST in hour 23" \
    "(SELECT string_agg(\"hourOfDay\" || ':' || \"eventCount\", ',' ORDER BY \"hourOfDay\") FROM analytics.\"eventHourly\" WHERE \"eventId\" = 'dst_test' AND \"bucketDate\" = '2026-11-01') = '0:1,1:2,23:1'"
loc -c "DELETE FROM data.\"dexAnalytics\" WHERE \"userId\" = 'dst-test-user'"
refresh
assert "Removing DST events restores the rollups" "'$(rollup_hash)' = '$BASE'"

# Excluding an account removes it everywhere; removing the exclusion restores it.
USER_ID="$(loc -At -c "SELECT \"userId\" FROM data.\"dexAnalytics\" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")"
USER_EVENTS="$(loc -At -c "SELECT count(*) FROM data.\"dexAnalytics\" WHERE \"userId\" = '$USER_ID'")"
TOTAL="$(loc -At -c 'SELECT sum("eventCount") FROM analytics."eventDaily"')"
loc -c "INSERT INTO analytics.\"excludedUser\" (\"tenantId\", \"propertyId\", \"userId\", reason) VALUES (15001, 1500001, '$USER_ID', 'test account')"
refresh
assert "Excluded account has no guest rows" "NOT EXISTS (SELECT 1 FROM analytics.\"guestDaily\" WHERE \"userId\" = '$USER_ID')"
assert "Excluded account's $USER_EVENTS events leave eventDaily" "(SELECT sum(\"eventCount\") FROM analytics.\"eventDaily\") = $TOTAL - $USER_EVENTS"
loc -c "DELETE FROM analytics.\"excludedUser\" WHERE \"userId\" = '$USER_ID'"
refresh
assert "Removing the exclusion restores the rollups" "'$(rollup_hash)' = '$BASE'"

# Ingest must not fail when the analytics queue is broken.
loc -c 'ALTER TABLE analytics."refreshQueue" RENAME TO "refreshQueueBroken"'
loc -c "INSERT INTO data.\"dexAnalytics\" (\"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"createdDate\")
        VALUES (1500001, 15001, gen_random_uuid(), 'broken-queue-user', 'app_opened', now())" 2>&1 | sed 's/^/  (expected) /'
loc -c 'ALTER TABLE analytics."refreshQueueBroken" RENAME TO "refreshQueue"'
assert "Insert succeeds even when the queue table is missing" \
    "EXISTS (SELECT 1 FROM data.\"dexAnalytics\" WHERE \"userId\" = 'broken-queue-user')"
loc -c "DELETE FROM data.\"dexAnalytics\" WHERE \"userId\" = 'broken-queue-user'"
refresh

# Two refreshes at once over the same queue.
loc -At -c 'SELECT analytics."markDirty"(15001, 1500001)' >/dev/null
refresh > "$WORK/r1.log" 2>&1 &
refresh > "$WORK/r2.log" 2>&1 &
wait
cat "$WORK/r1.log" "$WORK/r2.log"
assert "Concurrent refreshes give identical rollups" "'$(rollup_hash)' = '$BASE'"
assert "Concurrent refreshes leave an empty queue" "NOT EXISTS (SELECT 1 FROM analytics.\"refreshQueue\")"

step "Golden values and invariants after behaviour tests"
run_checks

step "All tests passed"
