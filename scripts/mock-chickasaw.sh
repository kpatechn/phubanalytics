#!/usr/bin/env bash
# Builds the mock Chickasaw CDP data in schema cdp_mock of the GEM dev database (dexiga):
# other sites' gaming, Agilysys non-gaming, opt-ins and app events, around the real WinStar
# sample. Drops and rebuilds the whole schema, reads dexiga, writes nothing outside cdp_mock,
# then runs the checks. Same inputs give the same rows.
#
# Usage: scripts/mock-chickasaw.sh [service]        (default: gem-dev, from ~/.pg_service.conf)
# Window: START_DATE, END_DATE (default 2024-06-04 .. 2025-07-04: 13 months up to the WinStar
# sample's last load). Override the connection with GEM_CONN.
# Remove it all: psql "service=gem-dev dbname=dexiga" -f db/cdp-mock/drop.sql
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${1:-gem-dev}"
CONN="${GEM_CONN:-service=$SERVICE dbname=dexiga}"
START_DATE="${START_DATE:-2024-06-04}"
END_DATE="${END_DATE:-2025-07-04}"

if [[ "$SERVICE" != *dev* && "${ALLOW_NON_DEV:-}" != 1 ]]; then
    echo "Refusing to write mock data through '$SERVICE': not a dev service (ALLOW_NON_DEV=1 overrides)." >&2
    exit 1
fi

for step in 00_schema 10_visits_gaming 20_non_gaming 30_consent 40_app; do
    echo "== $step"
    psql "$CONN" -X -w -q -v ON_ERROR_STOP=1 -v start_date="$START_DATE" -v end_date="$END_DATE" \
        -c 'SET client_min_messages = warning' -f "$ROOT/db/cdp-mock/$step.sql"
done

echo "== checks"
psql "$CONN" -X -w -q -v ON_ERROR_STOP=1 -P footer=off -f "$ROOT/db/cdp-mock/90_checks.sql"
