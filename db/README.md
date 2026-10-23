# Analytics database (`dexl`)

Raw app events land in `data."dexAnalytics"` (written by the ingest service). Everything the dashboards read lives in schema `analytics` and is rebuilt from those raw events.

## Layout

| Path | What it is |
|---|---|
| `migrations/001_analytics_rollups.sql` | Replaces the first-generation `analytics` objects with the design below |
| `migrations/002_engagement.sql` | Foreground flag on the event catalog and active-account columns on `guestDaily` (DAU/WAU/MAU) |
| `migrations/003_dextrans.sql` | `postgres_fdw` link to database `dextrans` and rollups for sessions, devices, message delivery, campaigns, tiers and scheduled jobs |
| `ops/dextrans_reader.sql`, `ops/link_dextrans.sql`, `../scripts/link-dextrans.sh` | Read-only `dextrans` role and the link's connection and login, per environment |
| `tests/dextrans_checks.sql`, `../scripts/test-dextrans-local.sh` | Platform rollups vs direct counts (days before today); local end-to-end test of the link |
| `rollback/` | Tested rollbacks for 003 and 002 and the reader role (`../scripts/test-rollback-local.sh`) |
| `seeds/001_event_catalog.sql` | Event display names, categories, feature map, dimension rules (all environments) |
| `seeds/graton_dev_property.sql` | Graton dev property row. Inserting it queues its whole history |
| `tests/rollup_checks.sql` | Graton-dev golden values from the plan, then `rollup_invariants.sql`. Dev only |
| `tests/rollup_invariants.sql` | Raw-vs-rollup invariants for any environment (skips days still queued). Read-only |
| `../scripts/test-rollups-local.sh` | Runs all of it on a throwaway local database against a scrubbed copy of dev events |

## How it works

```
data."dexAnalytics"  --(insert/update/delete trigger)-->  analytics."refreshQueue"   (UTC hours touched)
                                                                   |
                                     CALL analytics."refreshRollups"()   every few minutes
                                                                   |
                       maps hours to property-local days, then for each day, in one transaction:
                       delete that day's rollup rows, rebuild them from raw events
```

- **Local days.** `analytics.property."timeZone"` sets day boundaries. Graton is `America/Los_Angeles`. DST days have 23 or 25 hours; on the autumn change both 01:00 hours share `hourOfDay` 1.
- **Idempotent.** A day is always rebuilt from scratch, so running twice, late events, deleted events (privacy) and new exclusions all converge to the same answer.
- **Ingest is never blocked.** The trigger only appends to the queue and turns its own errors into warnings.
- **Concurrent refreshes are safe.** Work on the same day is serialized by an advisory lock.
- **Failures stay queued.** A day that fails is logged in `analytics."refreshRun"` and retried on the next call.

## Tables

| Table | Grain | Used for |
|---|---|---|
| `property` | tenant + property | Time zone, environment |
| `eventCatalog` | eventId | Display names, categories, feature map (query time) |
| `dimensionRule` | eventId + dimension | Which attributes become breakdowns. Changing it rebuilds history |
| `excludedUser` | account | Staff and test accounts left out of every rollup |
| `geofenceZone` | geofence ID | Display names, test-zone flag (query time) |
| `eventDaily` | day, event, on/off-site | KPIs, daily series, feature usage |
| `eventHourly` | day, local hour, event, on/off-site | Hour-of-day activity |
| `eventDimensionDaily` | day, event, dimension, value | Screens, message titles, campaigns, denial types, geofences, web pages (with average time), auth methods |
| `apiErrorDaily` | day, endpoint, method, status, type, code, message | IT errors. Endpoints and messages normalized, credentials redacted |
| `guestDaily` | day, account | DAU/WAU/MAU, new vs returning, retention, on-property active. **Contains account IDs** |
| `guestEventDaily` | day, account, event | Distinct guests per event or feature over any range. **Contains account IDs** |
| `refreshQueue`, `refreshRun`, view `refreshStatus` | | Refresh bookkeeping and health (`/readyz`, "data as of") |

An account is **active** on a day when `guestDaily."foregroundEventCount" > 0`: at least one event whose catalog entry has `"isForeground"`. Geofence triggers, push receipts, backgrounding, permission status checks and API errors are not foreground; events missing from the catalog never count. Changing `"isForeground"` rebuilds history.

Guests are identified by `"userId"` (the dex account). The plan's "13 accounts" counted `attributes.player_id`, which mixes card numbers and account IDs; by account it is 8.

## Platform data from `dextrans`

`dexl` and `dextrans` are separate databases. Migration 003 adds `postgres_fdw` foreign tables (schema `dextrans` in `dexl`) that declare only the columns analytics needs, read through the role `analytics_dextrans_reader`. That role has column-level SELECT on exactly those columns, nothing else: no names, contacts, card numbers, tokens, OTPs, IPs or locations.

`analytics."refreshDextrans"()` (pg_cron, every 15 minutes) rebuilds the last 3 local days, the last 45 days of campaign sends, and the snapshot tables:

| Table | Grain | From |
|---|---|---|
| `sessionDaily` | day, platform, app version, on/off property | `dexauth.userSessions`: sessions, length distribution |
| `guestDeviceDaily` | day, account, device, platform, version, model | sessions + `deviceInfos`. **Contains account and device IDs** |
| `eventVersionDaily` | day, platform, version | app events joined to their session: events and API errors per version |
| `pushDeliveryDaily` | day, message type, status, reason | `dexcomm.apnLogs`; reasons normalized (tokens, IDs, card numbers removed) |
| `campaign`, `campaignDaily` | campaign; sent day, campaign, channel | `phcamp.campaignMaster`, `campaignStats` (funnel by sent day) |
| `accountTier` | account | `dexpatron.cards`: current tier. **Contains account IDs** |
| `jobRunDaily`, `jobLatest` | day, job; job | `dexcron.jobStatus`: runs, failures, stuck runs, duration |

Test campaigns and jobs are flagged by name (`analytics."looksLikeTest"`); `analytics."campaignFlag"` overrides a campaign's flag. A dextrans failure is logged in `refreshRun` (`kind = 'dextrans'`) and never blocks the event rollups. To rebuild all history: `CALL analytics."refreshDextrans"(400, 400)`.

Set up or rotate the link (new random password; dextrans receives only its SCRAM verifier; nothing is printed):

```bash
scripts/link-dextrans.sh graton-dev
```

## Deploy to an environment

Production: follow [docs/production-rollout.md](../docs/production-rollout.md). The commands below are the short version used on dev.

Deployed to Graton dev on 2026-10-22: migrations 001–003, the dextrans link, all checks pass. Scheduled the same day with pg_cron:
- **Parameter group:** `playerhub-phub-graton-dev-uw2-pg-pg`, used only by this instance. `shared_preload_libraries = pg_stat_statements,pg_tle,pg_cron` and `cron.database_name = dexl`.
- **Jobs:** `analytics-refresh` every 5 minutes, `analytics-dextrans-refresh` every 15 minutes, and `cron-history-purge` daily.
- **Verified:** the first scheduled run (18:25 UTC) rebuilt 3 queued days.

```bash
psql "service=graton-dev dbname=dexl" -v ON_ERROR_STOP=1 -f db/migrations/001_analytics_rollups.sql
psql "service=graton-dev dbname=dexl" -v ON_ERROR_STOP=1 -f db/migrations/002_engagement.sql
psql "service=graton-dev dbname=dexl" -v ON_ERROR_STOP=1 -f db/migrations/003_dextrans.sql
psql "service=graton-dev dbname=dexl" -v ON_ERROR_STOP=1 -f db/seeds/001_event_catalog.sql
psql "service=graton-dev dbname=dexl" -v ON_ERROR_STOP=1 -f db/seeds/graton_dev_property.sql
psql "service=graton-dev dbname=dexl" -c 'CALL analytics."refreshRollups"()'
psql "service=graton-dev dbname=dexl" -f db/tests/rollup_checks.sql
```

Then schedule `CALL analytics."refreshRollups"()` every 5 minutes. It must run outside an explicit transaction.
- **pg_cron (chosen):** add `pg_cron` to `shared_preload_libraries` and set `cron.database_name = dexl` in the instance's parameter group, reboot, then run `db/ops/schedule_refresh.sql` as an `rds_superuser`.
- **Fallback, the analytics API process:** a timer that runs the CALL. No infrastructure change.

## Test locally

```bash
scripts/test-rollups-local.sh
```

Needs a local Postgres 16+ on `localhost:5432` and the `graton-dev` service entry (dev is only read). The script copies events with URL query strings, account numbers, coordinates and raw payloads removed, and drops the local database when it finishes (`KEEP_DB=1` keeps it).
