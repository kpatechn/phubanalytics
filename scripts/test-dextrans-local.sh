#!/usr/bin/env bash
# Tests migration 003 and the dextrans link on throwaway local databases:
#   phub_dextrans_test  the 7 dextrans tables (full definitions from dev; data only
#                       in the granted columns, failure messages scrubbed)
#   phub_dexl_test      raw events (scrubbed) + migrations 001-003 + seeds
# Links them with scripts/link-dextrans.sh, backfills, runs the rollup and dextrans
# checks, re-runs the refresh, and proves the reader role can't read other columns
# or write. Dev is only read. Both databases and the local role are dropped at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DEXL="service=graton-dev dbname=dexl"
DEV_DEXTRANS="service=graton-dev dbname=dextrans"
LOCAL_HOST="${LOCAL_HOST:-localhost}"
LOCAL_PORT="${LOCAL_PORT:-5432}"
DEXL_DB=phub_dexl_test
DEXTRANS_DB=phub_dextrans_test
LDEXL="host=$LOCAL_HOST port=$LOCAL_PORT dbname=$DEXL_DB"
LDEXTRANS="host=$LOCAL_HOST port=$LOCAL_PORT dbname=$DEXTRANS_DB"

WORK="$(mktemp -d)"
cleanup() {
    rm -rf "$WORK"
    if [[ "${KEEP_DB:-0}" != "1" ]]; then
        dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists "$DEXL_DB" >/dev/null 2>&1 || true
        dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists "$DEXTRANS_DB" >/dev/null 2>&1 || true
        psql -h "$LOCAL_HOST" -p "$LOCAL_PORT" -X -q -d postgres -c 'DROP ROLE IF EXISTS analytics_dextrans_reader' >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

dev() { PGOPTIONS='-c default_transaction_read_only=on' psql "$1" -X -w -v ON_ERROR_STOP=1 -q -c "$2"; }
loc() { local conn="$1"; shift; psql "$conn" -X -w -v ON_ERROR_STOP=1 -q "$@"; }
step() { printf '\n== %s\n' "$*"; }
assert() { # assert "<description>" "<conn>" "<sql returning true>"
    local ok; ok="$(loc "$2" -At -c "SELECT ($3)::boolean")"
    if [[ "$ok" == "t" ]]; then echo "PASS  $1"; else echo "FAIL  $1"; exit 1; fi
}
denied() { # denied "<description>" "<sql run as the reader>"
    if psql "$LDEXTRANS user=analytics_dextrans_reader" -X -w -q -c "$2" >/dev/null 2>"$WORK/err"; then
        echo "FAIL  $1 (query succeeded)"; exit 1
    fi
    if grep -qiE 'permission denied|read-only transaction' "$WORK/err"; then echo "PASS  $1"; else cat "$WORK/err"; echo "FAIL  $1"; exit 1; fi
}

step "Create local databases"
for db in "$DEXL_DB" "$DEXTRANS_DB"; do
    dropdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" --if-exists "$db"
    createdb -h "$LOCAL_HOST" -p "$LOCAL_PORT" "$db"
done

step "dextrans copy: table definitions from dev, data only in the columns analytics may read"
loc "$LDEXTRANS" -c 'CREATE SCHEMA dexauth; CREATE SCHEMA dexcomm; CREATE SCHEMA dexcron; CREATE SCHEMA dexpatron; CREATE SCHEMA phcamp;'
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$DEV_DEXTRANS" -w --schema-only --no-owner --no-privileges \
    -t 'dexauth."userSessions"' -t 'dexauth."deviceInfos"' -t 'dexcomm."apnLogs"' -t 'phcamp."campaignMaster"' \
    -t 'phcamp."campaignStats"' -t 'dexpatron.cards' -t 'dexcron."jobStatus"' \
    | grep -vE '^\\(un)?restrict ' \
    | python3 -I -c 'import sys; print(";\n".join(s for s in sys.stdin.read().split(";\n") if "FOREIGN KEY" not in s))' \
    > "$WORK/dextrans.sql"   # foreign keys point at tables this copy doesn't have
loc "$LDEXTRANS" -f "$WORK/dextrans.sql" >/dev/null
# Only granted columns get data, so the other columns must accept nulls here.
loc "$LDEXTRANS" -c "DO \$\$ DECLARE c record; BEGIN
  FOR c IN SELECT a.attrelid::regclass AS t, a.attname AS col FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = k.relnamespace
           WHERE n.nspname IN ('dexauth','dexcomm','dexcron','dexpatron','phcamp') AND k.relkind = 'r' AND a.attnum > 0
             AND a.attnotnull AND NOT a.attisdropped
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', c.t, c.col);
  END LOOP; END \$\$;"

copy() { # copy <table> <columns> <select list>
    PGOPTIONS='-c default_transaction_read_only=on' psql "$DEV_DEXTRANS" -X -w -v ON_ERROR_STOP=1 -q \
        -c "COPY (SELECT $3 FROM $1) TO STDOUT WITH (FORMAT csv)" > "$WORK/rows.csv"
    loc "$LDEXTRANS" -c "COPY $1 ($2) FROM STDIN WITH (FORMAT csv)" < "$WORK/rows.csv"
    echo "  $1: $(wc -l < "$WORK/rows.csv" | tr -d ' ') rows"
}
S='"sessionId", "tenantId", "propertyId", "dexUserId", "deviceId", platform, "appVersion", "locationContext", "startedAtUtc", "endedAtUtc"'
copy 'dexauth."userSessions"' "id, $S" "gen_random_uuid(), $S"
D='"deviceId", "tenantId", "propertyId", "userId", "systemName", "deviceName", version, "modifiedDate"'
copy 'dexauth."deviceInfos"' "id, $D" "id, $D"
copy 'dexcomm."apnLogs"' 'id, "notifiedAt", event, "tenantId", "propertyId", status, "respMsg"' \
    "id, \"notifiedAt\", event, \"tenantId\", \"propertyId\", status, regexp_replace(regexp_replace(\"respMsg\", '[A-Za-z0-9_:-]{25,}', 'scrubbedtokenxxxxxxxxxxxxxxxxxx', 'g'), '[0-9]{4,}', '00000', 'g')"
M='id, "tenantId", "propertyId", name, category, status, "targetType", "scheduleType", "startDate", "endDate", "isDelete"'
copy 'phcamp."campaignMaster"' "$M" "$M"
C='"campaignStatId", "tenantId", "propertyId", "campaignId", channel, status, "sentAt", "deliveredAt", "openedAt", "clickedAt", "convertedAt", "unSubAt"'
copy 'phcamp."campaignStats"' "$C" "$C"
K='"userId", "tenantId", "propertyId", "clubName", "isActive", "modifiedDate"'
copy 'dexpatron.cards' "id, $K" "id, $K"
J='"jobExecutionId", "tenantId", "propertyId", "jobName", "startTime", "endTime", status'
copy 'dexcron."jobStatus"' "$J" "$J"
# Values the reader must not see, to prove it can't: a column outside its grant and
# a table it has no grant on (a stand-in for dexauth.accounts with its OTP column).
loc "$LDEXTRANS" -c "UPDATE dexcomm.\"apnLogs\" SET \"accountNo\" = 'secret' WHERE id = (SELECT id FROM dexcomm.\"apnLogs\" LIMIT 1)"
loc "$LDEXTRANS" -c "CREATE TABLE dexauth.accounts (id uuid PRIMARY KEY, otp text); INSERT INTO dexauth.accounts VALUES (gen_random_uuid(), 'secret')"

step "dexl copy: raw events (scrubbed), migrations, seeds"
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$DEV_DEXL" -w --schema-only --no-owner --no-privileges -t 'data."dexAnalytics"' \
    | grep -vE '^\\(un)?restrict ' | grep -v '^CREATE TRIGGER' > "$WORK/table.sql"
loc "$LDEXL" -c 'CREATE SCHEMA data'
loc "$LDEXL" -f "$WORK/table.sql" >/dev/null
PGOPTIONS='-c default_transaction_read_only=on' psql "$DEV_DEXL" -X -w -v ON_ERROR_STOP=1 -q -c "COPY (
    SELECT id, \"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"mobileName\", \"locationContext\",
           CASE WHEN jsonb_typeof(attributes) = 'object' THEN (attributes - 'account_number' - 'url') ELSE attributes END,
           \"createdDate\"
      FROM data.\"dexAnalytics\") TO STDOUT WITH (FORMAT csv)" > "$WORK/events.csv"
loc "$LDEXL" -c "COPY data.\"dexAnalytics\" (id, \"propertyId\", \"tenantId\", \"sessionId\", \"userId\", \"eventId\", \"mobileName\", \"locationContext\", attributes, \"createdDate\") FROM STDIN WITH (FORMAT csv)" < "$WORK/events.csv"
rm -f "$WORK/events.csv" "$WORK/rows.csv"
for migration in "$ROOT"/db/migrations/*.sql; do
    echo "  $(basename "$migration")"
    loc "$LDEXL" -f "$migration" >/dev/null
done
loc "$LDEXL" -f "$ROOT/db/seeds/001_event_catalog.sql" >/dev/null
loc "$LDEXL" -f "$ROOT/db/seeds/graton_dev_property.sql" >/dev/null
loc "$LDEXL" -c 'CALL analytics."refreshRollups"()' >/dev/null

step "Link with scripts/link-dextrans.sh"
DEXL_CONN="$LDEXL" DEXTRANS_CONN="$LDEXTRANS" DEXTRANS_HOST="$LOCAL_HOST" DEXTRANS_PORT="$LOCAL_PORT" DEXTRANS_DBNAME="$DEXTRANS_DB" \
    "$ROOT/scripts/link-dextrans.sh"

step "Backfill all history"
START=$(date +%s)
loc "$LDEXL" -c 'CALL analytics."refreshDextrans"(400, 400)'
echo "refreshDextrans took $(( $(date +%s) - START ))s"
loc "$LDEXL" -P pager=off -c 'SELECT kind, status, "daysRefreshed", "daysFailed", "eventsScanned" AS "rowsRead", error FROM analytics."refreshRun" WHERE kind = '"'dextrans'"' ORDER BY "runId" DESC LIMIT 1'

step "Checks"
for f in rollup_checks dextrans_checks; do
    loc "$LDEXL" -P pager=off -f "$ROOT/db/tests/$f.sql" | tee "$WORK/$f.txt"
    if grep -q 'FAIL' "$WORK/$f.txt"; then echo "$f.sql has failures"; exit 1; fi
done

step "Behaviour"
HASH="SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT row(\"bucketDate\", platform, \"appVersion\", \"locationContext\", sessions, \"endedSessions\", \"durationSeconds\", \"lengthUnder30s\", \"lengthOver60m\")::text x FROM analytics.\"sessionDaily\"
    UNION ALL SELECT row(\"bucketDate\", \"userId\", \"deviceId\", platform, \"appVersion\", model, sessions)::text FROM analytics.\"guestDeviceDaily\"
    UNION ALL SELECT row(\"bucketDate\", platform, \"appVersion\", \"eventCount\", \"errorCount\")::text FROM analytics.\"eventVersionDaily\"
    UNION ALL SELECT row(\"bucketDate\", \"messageType\", status, reason, sends)::text FROM analytics.\"pushDeliveryDaily\"
    UNION ALL SELECT row(\"bucketDate\", \"campaignId\", channel, sent, delivered, opened, clicked, converted, unsubscribed)::text FROM analytics.\"campaignDaily\"
    UNION ALL SELECT row(\"campaignId\", name, \"isTest\")::text FROM analytics.campaign
    UNION ALL SELECT row(\"userId\", tier)::text FROM analytics.\"accountTier\"
    UNION ALL SELECT row(\"bucketDate\", \"jobName\", runs, completed, failed, \"durationSeconds\")::text FROM analytics.\"jobRunDaily\") s"
BEFORE="$(loc "$LDEXL" -At -c "$HASH")"
loc "$LDEXL" -c 'CALL analytics."refreshDextrans"(400, 400)'
assert "Re-running the backfill gives identical rollups" "$LDEXL" "'$(loc "$LDEXL" -At -c "$HASH")' = '$BEFORE'"
loc "$LDEXL" -c 'CALL analytics."refreshDextrans"()'
assert "The default 3-day refresh leaves history unchanged" "$LDEXL" "'$(loc "$LDEXL" -At -c "$HASH")' = '$BEFORE'"
assert "Test campaigns are flagged by name" "$LDEXL" "(SELECT bool_and(\"isTest\") FROM analytics.campaign WHERE name ~* '\\mtest')"
loc "$LDEXL" -c "INSERT INTO analytics.\"campaignFlag\" (\"campaignId\", \"isTest\", reason) SELECT \"campaignId\", false, 'override test' FROM analytics.campaign WHERE \"isTest\" LIMIT 1"
loc "$LDEXL" -c 'CALL analytics."refreshDextrans"()'
assert "campaignFlag overrides the name rule" "$LDEXL" "EXISTS (SELECT 1 FROM analytics.campaign c JOIN analytics.\"campaignFlag\" f USING (\"campaignId\") WHERE NOT c.\"isTest\")"

denied "Reader can't read a column outside its grant (apnLogs.accountNo)" 'SELECT "accountNo" FROM dexcomm."apnLogs" LIMIT 1'
denied "Reader can't SELECT * (userSessions has ungranted columns)" 'SELECT * FROM dexauth."userSessions" LIMIT 1'
denied "Reader can't read tables it wasn't granted (accounts)" 'SELECT 1 FROM dexauth.accounts LIMIT 1'
denied "Reader can't write" "UPDATE dexcron.\"jobStatus\" SET status = 'x' WHERE false"

# A broken link is logged and doesn't stop the event rollups.
loc "$LDEXL" -c "ALTER SERVER dextrans OPTIONS (SET dbname 'missing_db')"
loc "$LDEXL" -c 'CALL analytics."refreshDextrans"()' 2>&1 | sed 's/^/  (expected) /'
assert "A failed dextrans refresh is recorded as failed" "$LDEXL" "(SELECT status FROM analytics.\"refreshRun\" WHERE kind = 'dextrans' ORDER BY \"runId\" DESC LIMIT 1) = 'failed'"
loc "$LDEXL" -c 'CALL analytics."refreshRollups"()' >/dev/null
assert "Event rollups still refresh while dextrans is down" "$LDEXL" "(SELECT status FROM analytics.\"refreshRun\" WHERE kind = 'events' ORDER BY \"runId\" DESC LIMIT 1) = 'succeeded'"
loc "$LDEXL" -c "ALTER SERVER dextrans OPTIONS (SET dbname '$DEXTRANS_DB')"

step "All tests passed"
