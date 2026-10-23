#!/usr/bin/env bash
# Tests db/rollback/* on throwaway local databases: full install (via
# scripts/test-dextrans-local.sh), then 003 down, 003 up, 003 + 002 down, and
# 002 + 003 up again, checking after every step. Dev is only read.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_HOST="${LOCAL_HOST:-localhost}"
LOCAL_PORT="${LOCAL_PORT:-5432}"
LDEXL="host=$LOCAL_HOST port=$LOCAL_PORT dbname=phub_dexl_test"
LDEXTRANS="host=$LOCAL_HOST port=$LOCAL_PORT dbname=phub_dextrans_test"

WORK="$(mktemp -d)"
cleanup() {
    rm -rf "$WORK"
    dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists phub_dexl_test >/dev/null 2>&1 || true
    dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists phub_dextrans_test >/dev/null 2>&1 || true
    psql -h "$LOCAL_HOST" -p "$LOCAL_PORT" -X -q -d postgres -c 'DROP ROLE IF EXISTS analytics_dextrans_reader' >/dev/null 2>&1 || true
}
trap cleanup EXIT

loc() { local conn="$1"; shift; psql "$conn" -X -w -v ON_ERROR_STOP=1 -q "$@"; }
step() { printf '\n== %s\n' "$*"; }
assert() { # assert "<description>" "<conn>" "<sql returning true>"
    local ok; ok="$(loc "$2" -At -c "SELECT ($3)::boolean")"
    if [[ "$ok" == "t" ]]; then echo "PASS  $1"; else echo "FAIL  $1"; exit 1; fi
}
checks() { # checks <file...>: every row PASS
    for f in "$@"; do
        loc "$LDEXL" -At -F'|' -f "$ROOT/db/tests/$f.sql" > "$WORK/$f.txt"
        local fails; fails="$(grep -c '|FAIL$' "$WORK/$f.txt" || true)"
        if [[ "$fails" != "0" ]]; then cat "$WORK/$f.txt"; echo "FAIL  $f.sql"; exit 1; fi
        echo "PASS  $f.sql ($(grep -c '|PASS$' "$WORK/$f.txt") rows)"
    done
}
link_and_backfill() {
    DEXL_CONN="$LDEXL" DEXTRANS_CONN="$LDEXTRANS" DEXTRANS_HOST="$LOCAL_HOST" DEXTRANS_PORT="$LOCAL_PORT" DEXTRANS_DBNAME=phub_dextrans_test \
        "$ROOT/scripts/link-dextrans.sh" >/dev/null
    loc "$LDEXL" -c 'CALL analytics."refreshDextrans"(400, 400)'
}

step "Full install (scripts/test-dextrans-local.sh, databases kept)"
KEEP_DB=1 "$ROOT/scripts/test-dextrans-local.sh" > "$WORK/install.log" 2>&1 || { tail -30 "$WORK/install.log"; exit 1; }
grep -E '^== All tests passed' "$WORK/install.log"
RAW="$(loc "$LDEXL" -At -c 'SELECT count(*) FROM data."dexAnalytics"')"

step "003 down"
loc "$LDEXL" -f "$ROOT/db/rollback/003_dextrans_down.sql"
assert "Foreign schema, server and extension are gone" "$LDEXL" \
    "to_regnamespace('dextrans') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_foreign_server) AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgres_fdw')"
assert "Platform rollups are gone, refreshRun.kind removed" "$LDEXL" \
    "to_regclass('analytics.\"sessionDaily\"') IS NULL AND to_regclass('analytics.\"jobLatest\"') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'refreshRun' AND column_name = 'kind')"
loc "$LDEXL" -c 'SELECT analytics."markDirty"(15001, 1500001)' >/dev/null
loc "$LDEXL" -c 'CALL analytics."refreshRollups"()' >/dev/null
assert "Event rollups still rebuild all history" "$LDEXL" "(SELECT sum(\"eventCount\") FROM analytics.\"eventDaily\") = $RAW"
checks rollup_checks
loc "$LDEXTRANS" -f "$ROOT/db/rollback/dextrans_reader_drop.sql"
assert "Reader role is dropped" "$LDEXTRANS" "NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_dextrans_reader')"

step "003 up again"
loc "$LDEXL" -f "$ROOT/db/migrations/003_dextrans.sql" >/dev/null
link_and_backfill
checks rollup_checks dextrans_checks

step "003 and 002 down"
loc "$LDEXL" -f "$ROOT/db/rollback/003_dextrans_down.sql"
loc "$LDEXL" -f "$ROOT/db/rollback/002_engagement_down.sql"
loc "$LDEXTRANS" -f "$ROOT/db/rollback/dextrans_reader_drop.sql"
assert "Foreground columns and trigger are gone" "$LDEXL" \
    "NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'analytics' AND column_name IN ('isForeground', 'foregroundEventCount', 'onsiteForegroundEventCount')) AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'eventCatalog_queue_history')"
loc "$LDEXL" -c 'SELECT analytics."markDirty"(15001, 1500001)' >/dev/null
loc "$LDEXL" -c 'CALL analytics."refreshRollups"()' >/dev/null
assert "001's refresh rebuilds all history" "$LDEXL" \
    "(SELECT sum(\"eventCount\") FROM analytics.\"eventDaily\") = $RAW AND (SELECT status FROM analytics.\"refreshRun\" ORDER BY \"runId\" DESC LIMIT 1) = 'succeeded'"

step "002 and 003 up again"
loc "$LDEXL" -f "$ROOT/db/migrations/002_engagement.sql" >/dev/null
loc "$LDEXL" -c 'CALL analytics."refreshRollups"()' >/dev/null
loc "$LDEXL" -f "$ROOT/db/migrations/003_dextrans.sql" >/dev/null
link_and_backfill
checks rollup_checks dextrans_checks

step "All rollback tests passed"
