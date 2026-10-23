#!/usr/bin/env bash
# Builds the Chickasaw CDP prototype (schema cdp in the GEM dev database dexiga): recreates the
# schema, runs CALL cdp.refresh() over the WinStar data and the cdp_mock feeds, then the checks.
# Everything in cdp is derived, so rebuilding loses nothing. Needs cdp_mock first
# (scripts/mock-chickasaw.sh).
#
# Usage: scripts/build-cdp.sh [service]        (default: gem-dev, from ~/.pg_service.conf)
# REFRESH_ONLY=1 skips recreating the schema (keeps cdp.setting and segment edits).
# Override the connection with GEM_CONN. Remove it: psql "service=gem-dev dbname=dexiga" -c 'DROP SCHEMA cdp CASCADE'
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${1:-gem-dev}"
CONN="${GEM_CONN:-service=$SERVICE dbname=dexiga}"

if [[ "$SERVICE" != *dev* && "${ALLOW_NON_DEV:-}" != 1 ]]; then
    echo "Refusing to build the CDP prototype through '$SERVICE': not a dev service (ALLOW_NON_DEV=1 overrides)." >&2
    exit 1
fi

if [[ "$(psql "$CONN" -X -w -At -c "select to_regclass('cdp_mock.player') is not null")" != t ]]; then
    echo "cdp_mock is missing: run scripts/mock-chickasaw.sh first." >&2
    exit 1
fi

if [[ "${REFRESH_ONLY:-}" != 1 ]]; then
    echo "== schema"
    psql "$CONN" -X -w -q -v ON_ERROR_STOP=1 -c 'SET client_min_messages = warning' -f "$ROOT/db/cdp/001_cdp.sql"
fi

echo "== refresh"
psql "$CONN" -X -w -q -v ON_ERROR_STOP=1 -c 'CALL cdp.refresh()'
psql "$CONN" -X -w -At -c "select 'as of ' || as_of_date || ' in ' || round(extract(epoch from finished_at - started_at)) || 's: ' || row_counts from cdp.refresh_run order by run_id desc limit 1"

echo "== checks"
psql "$CONN" -X -w -q -v ON_ERROR_STOP=1 -P footer=off -f "$ROOT/db/cdp/tests/cdp_checks.sql"
