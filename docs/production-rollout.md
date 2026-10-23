# PlayerHub Analytics: production rollout guide

How to take the analytics database layer and dashboard from Graton dev to production. Every step here has been run on Graton dev (2026-10-22) and is covered by local tests; where production may differ, the guide says what to check first.

Placeholders: `<prod>` is the production libpq service name (an entry in `~/.pg_service.conf` like `graton-dev`), `<instance>` the RDS instance identifier, `<group>` its DB parameter group, `<admin>` the admin role that will own and run everything (on dev: `phub_dev_admin`).

## 1. At a glance

| Phase | What | Downtime | Who |
|---|---|---|---|
| A. Prepare | Decisions, pre-flight checks, backups, indexes in `dextrans` | None | DBA, platform team, analytics owner |
| B. Enable pg_cron | Parameter group change and one reboot | 1–2 min (less with Multi-AZ failover) | DBA |
| C. Database | Migrations 001–003, `dextrans` link, seeds, backfills, schedules, checks | None (ingest waits milliseconds for trigger creation) | DBA / analytics engineer |
| D. Dashboard | Read-only API role, deploy API and web app behind staff sign-in | None | Platform team |
| E. Operate | Monitoring, alerts, runbook | None | On-call |

Phases A–C deliver working rollups refreshed every 5 and 15 minutes. Phase D can follow later: it needs the identity provider and hosting decisions (section 3). **Run the whole guide on staging first if you have one.**

## 2. What gets deployed

All database objects live in database `dexl`, except one role in `dextrans`. Raw events (`data."dexAnalytics"`) and every `dextrans` table are only read, never changed.

| Source | Creates | Notes |
|---|---|---|
| `db/migrations/001_analytics_rollups.sql` | Schema `analytics`: config tables (`property`, `eventCatalog`, `dimensionRule`, `excludedUser`, `geofenceZone`), event rollups (`eventDaily`, `eventHourly`, `eventDimensionDaily`, `apiErrorDaily`, `guestDaily`, `guestEventDaily`), `refreshQueue`, `refreshRun`, view `refreshStatus`, refresh functions; 3 triggers on `data."dexAnalytics"` | **Drops** any first-generation `analytics` objects and the old `dexAnalytics_delta_after_insert` trigger |
| `db/migrations/002_engagement.sql` | `eventCatalog."isForeground"`, foreground columns on `guestDaily`, index, catalog trigger | DAU/WAU/MAU count foreground events only |
| `db/migrations/003_dextrans.sql` | Extension `postgres_fdw`, server `dextrans`, schema `dextrans` with 7 foreign tables (61 columns), platform rollups (`sessionDaily`, `guestDeviceDaily`, `eventVersionDaily`, `pushDeliveryDaily`, `campaign`, `campaignFlag`, `campaignDaily`, `accountTier`, `jobRunDaily`, `jobLatest`), `refreshDextrans` | Connection details come from the link script, not the migration |
| `scripts/link-dextrans.sh` (runs `db/ops/dextrans_reader.sql` and `db/ops/link_dextrans.sql`) | Role `analytics_dextrans_reader` in `dextrans` (column-level SELECT only), server options and user mapping in `dexl` | New random password; `dextrans` receives only its SCRAM verifier; nothing printed |
| `db/seeds/001_event_catalog.sql` | 57 events, 24 dimension rules | Same in every environment |
| Property, geofence and exclusion rows | One `analytics.property` row per property, display names, test accounts | Production values; templates in section 6.5 |
| `db/ops/schedule_refresh.sql` | pg_cron jobs `analytics-refresh` (5 min), `analytics-dextrans-refresh` (15 min), `cron-history-purge` (daily) | |
| `db/rollback/*` | Tested rollbacks for 003 and 002; 001 rolls back from the backup | Section 8 |

## 3. Decisions and prerequisites

Collect these before the change window. Owners are suggestions.

| # | Item | Why | Owner |
|---|---|---|---|
| 1 | Change approval and a maintenance window for one reboot | pg_cron needs a parameter change and reboot | DBA |
| 2 | Admin role `<admin>` in production with `rds_superuser`, `CREATEROLE`, and ownership of the `dextrans` schemas it will grant on (`dexauth`, `dexcomm`, `dexcron`, `dexpatron`, `phcamp`) | Runs migrations, creates the reader role, owns the pg_cron jobs and the user mapping | DBA |
| 3 | Every production property: `tenantId`, `propertyId`, name, IANA time zone | Day boundaries for all rollups | Analytics owner |
| 4 | Staff and test accounts to exclude (account UUIDs) | Production numbers must not include internal use | Product / operations |
| 5 | Geofence display names and which zones are tests | Readable zone names, test zones hidden | Marketing |
| 6 | Indexes in `dextrans` (section 6.2) | Remote filters on send, campaign, job and card tables have no index today | Platform team |
| 7 | Read the link from a `dextrans` read replica? | Keeps analytics reads off the transactional primary | DBA |
| 8 | Data retention (13 months in the plan) and account-deletion handling | Guest tables hold account IDs; no retention job exists yet (section 11) | Compliance |
| 9 | Identity provider issuing staff JWTs with roles `analytics:exec`, `analytics:marketing`, `analytics:it`, `analytics:admin` | API refuses dev auth outside dev | Platform team (Phase D) |
| 10 | Hosting, domain and TLS for the API and web app | Phase D | Platform team |

## 4. Pre-flight checks (read-only)

Run against production with a read-only session: `PGOPTIONS='-c default_transaction_read_only=on' psql "service=<prod> dbname=dexl"`. Record the output in the change ticket.

**4.1 Engine and libraries.** Expect PostgreSQL 16+; note whether `pg_cron` is already preloaded.
```sql
SELECT version();
SHOW shared_preload_libraries;
SELECT name, setting FROM pg_settings WHERE name IN ('log_statement', 'password_encryption', 'pg_stat_statements.track_utility');
```
If `log_statement` is `ddl` or `all`, the user-mapping password (section 6.3) would be written to the server log: set it to `none` for the change or accept that the RDS log holds it.

**4.2 The raw events table has the expected shape.** Every row must say `t`.
```sql
SELECT c AS column_, EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'data' AND table_name = 'dexAnalytics' AND column_name = c) AS present
  FROM unnest(ARRAY['id','tenantId','propertyId','sessionId','userId','eventId','mobileName','locationContext','attributes','createdDate']) c;
```

**4.3 Volume per property.** Sizes the backfill (dev: 12,893 events rebuilt in 0.5 s).
```sql
SELECT "tenantId", "propertyId", count(*) AS events, min("createdDate"), max("createdDate"),
       pg_size_pretty(pg_total_relation_size('data."dexAnalytics"')) AS table_size
  FROM data."dexAnalytics" GROUP BY 1, 2 ORDER BY 1, 2;
```

**4.4 What migration 001 will drop.** Lists existing `analytics` objects, triggers on the raw table, and anything outside `analytics` that depends on them. If something reads the first-generation tables, plan its cut-over first.
```sql
SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' ORDER BY 1;
SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'data."dexAnalytics"'::regclass AND NOT tgisinternal;
SELECT DISTINCT dn.nspname || '.' || dc.relname AS dependent
  FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class dc ON dc.oid = rw.ev_class
  JOIN pg_namespace dn ON dn.oid = dc.relnamespace JOIN pg_class rc ON rc.oid = d.refobjid
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
 WHERE rn.nspname = 'analytics' AND dn.nspname <> 'analytics';
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables WHERE schemaname = 'analytics';  -- non-zero = something reads it
```

**4.5 Roles.** `<admin>` must be in `rds_superuser` and have `CREATEROLE`.
```sql
SELECT r.rolname, r.rolcreaterole, pg_has_role(r.rolname, 'rds_superuser', 'member') AS rds_superuser
  FROM pg_roles r WHERE r.rolname = current_user;
```

**4.6 The 61 `dextrans` columns exist.** Run in `dextrans`. Any missing column means the app version differs from dev: stop and update migration 003.
```sql
SELECT t.schema_, t.table_, t.col, EXISTS (SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = t.schema_ AND c.table_name = t.table_ AND c.column_name = t.col) AS present
  FROM (VALUES
    ('dexauth','userSessions','sessionId'),
    ('dexauth','userSessions','tenantId'),
    ('dexauth','userSessions','propertyId'),
    ('dexauth','userSessions','dexUserId'),
    ('dexauth','userSessions','deviceId'),
    ('dexauth','userSessions','platform'),
    ('dexauth','userSessions','appVersion'),
    ('dexauth','userSessions','locationContext'),
    ('dexauth','userSessions','startedAtUtc'),
    ('dexauth','userSessions','endedAtUtc'),
    ('dexauth','deviceInfos','deviceId'),
    ('dexauth','deviceInfos','tenantId'),
    ('dexauth','deviceInfos','propertyId'),
    ('dexauth','deviceInfos','userId'),
    ('dexauth','deviceInfos','systemName'),
    ('dexauth','deviceInfos','deviceName'),
    ('dexauth','deviceInfos','version'),
    ('dexauth','deviceInfos','modifiedDate'),
    ('dexcomm','apnLogs','id'),
    ('dexcomm','apnLogs','notifiedAt'),
    ('dexcomm','apnLogs','event'),
    ('dexcomm','apnLogs','tenantId'),
    ('dexcomm','apnLogs','propertyId'),
    ('dexcomm','apnLogs','status'),
    ('dexcomm','apnLogs','respMsg'),
    ('phcamp','campaignMaster','id'),
    ('phcamp','campaignMaster','tenantId'),
    ('phcamp','campaignMaster','propertyId'),
    ('phcamp','campaignMaster','name'),
    ('phcamp','campaignMaster','category'),
    ('phcamp','campaignMaster','status'),
    ('phcamp','campaignMaster','targetType'),
    ('phcamp','campaignMaster','scheduleType'),
    ('phcamp','campaignMaster','startDate'),
    ('phcamp','campaignMaster','endDate'),
    ('phcamp','campaignMaster','isDelete'),
    ('phcamp','campaignStats','campaignStatId'),
    ('phcamp','campaignStats','tenantId'),
    ('phcamp','campaignStats','propertyId'),
    ('phcamp','campaignStats','campaignId'),
    ('phcamp','campaignStats','channel'),
    ('phcamp','campaignStats','status'),
    ('phcamp','campaignStats','sentAt'),
    ('phcamp','campaignStats','deliveredAt'),
    ('phcamp','campaignStats','openedAt'),
    ('phcamp','campaignStats','clickedAt'),
    ('phcamp','campaignStats','convertedAt'),
    ('phcamp','campaignStats','unSubAt'),
    ('dexpatron','cards','userId'),
    ('dexpatron','cards','tenantId'),
    ('dexpatron','cards','propertyId'),
    ('dexpatron','cards','clubName'),
    ('dexpatron','cards','isActive'),
    ('dexpatron','cards','modifiedDate'),
    ('dexcron','jobStatus','jobExecutionId'),
    ('dexcron','jobStatus','tenantId'),
    ('dexcron','jobStatus','propertyId'),
    ('dexcron','jobStatus','jobName'),
    ('dexcron','jobStatus','startTime'),
    ('dexcron','jobStatus','endTime'),
    ('dexcron','jobStatus','status')
  ) AS t(schema_, table_, col)
 ORDER BY present, 1, 2, 3;
```

**4.7 `dextrans` volumes.** Run in `dextrans`. Sizes the platform backfill (dev: 157,650 job runs, 28,682 sends, 9,281 campaign messages, 1,121 sessions in 1.9 s).
```sql
SELECT 'userSessions' AS t, count(*) FROM dexauth."userSessions"
UNION ALL SELECT 'apnLogs', count(*) FROM dexcomm."apnLogs"
UNION ALL SELECT 'campaignStats', count(*) FROM phcamp."campaignStats"
UNION ALL SELECT 'jobStatus', count(*) FROM dexcron."jobStatus";
```

**4.8 Who else uses the parameter group.** In CloudShell:
```bash
aws rds describe-db-instances --region us-west-2 --query "DBInstances[?DBParameterGroups[?DBParameterGroupName=='<group>']].DBInstanceIdentifier"
```
If any other instance is listed, create a dedicated group for this instance first (section 5).

## 5. Phase B: enable pg_cron (one reboot)

As on dev (2026-10-22). In CloudShell, with `<group>` used only by `<instance>`:

1. Read the group's current preload list:
   ```bash
   aws rds describe-db-parameters --region us-west-2 --db-parameter-group-name <group> --query "Parameters[?ParameterName=='shared_preload_libraries' || ParameterName=='cron.database_name'].[ParameterName,ParameterValue,Source]" --output table
   ```
2. Add `pg_cron` to that exact list (keep everything already there) and set `cron.database_name`:
   ```bash
   aws rds modify-db-parameter-group --region us-west-2 --db-parameter-group-name <group> --parameters '[{"ParameterName":"shared_preload_libraries","ParameterValue":"<current list>,pg_cron","ApplyMethod":"pending-reboot"},{"ParameterName":"cron.database_name","ParameterValue":"dexl","ApplyMethod":"pending-reboot"}]'
   ```
3. In the window, reboot (add `--force-failover` on Multi-AZ to cut downtime) and wait:
   ```bash
   aws rds reboot-db-instance --region us-west-2 --db-instance-identifier <instance>
   ```
   ```bash
   aws rds wait db-instance-available --region us-west-2 --db-instance-identifier <instance> && aws rds describe-db-instances --region us-west-2 --db-instance-identifier <instance> --query 'DBInstances[0].[DBInstanceStatus,DBParameterGroups[0].ParameterApplyStatus]'
   ```
   Expect `"available"`, `"in-sync"`.
4. Confirm in `dexl`: `SHOW shared_preload_libraries;` includes `pg_cron`, and `SHOW cron.database_name;` is `dexl`.

If the group is shared: create a dedicated one (`aws rds create-db-parameter-group --db-parameter-group-family postgres16 ...`), copy any custom settings from the old group, attach it with `aws rds modify-db-instance --db-parameter-group-name <new> --apply-immediately`, then do the steps above on the new group (one reboot covers both).

## 6. Phase C: database

Connect as `<admin>`: `DEXL="service=<prod> dbname=dexl"`, `DEXTRANS="service=<prod> dbname=dextrans"`. Every write command below uses a 10-second lock timeout so nothing ever queues behind ingest.

### 6.1 Back up

```bash
aws rds create-db-snapshot --region us-west-2 --db-instance-identifier <instance> --db-snapshot-identifier phub-analytics-before-001-$(date +%Y%m%d)
```
```bash
pg_dump "$DEXL" -n analytics -Fc -f analytics-before-001.dump
```
```bash
pg_dump "$DEXL" --schema-only -t 'data."dexAnalytics"' -f dexAnalytics-before-001.sql
```
Keep the two files with the change ticket; they are the rollback for migration 001 (section 8). The schema dump contains no event data; the `analytics` dump holds only first-generation rollups.

### 6.2 Indexes in `dextrans` (platform team, any time before 6.5)

The platform refresh filters these tables by property and time. Build without blocking writes:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "apnLogs_property_notifiedAt_idx"      ON dexcomm."apnLogs"        ("propertyId", "notifiedAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "campaignStats_property_sentAt_idx"    ON phcamp."campaignStats"   ("propertyId", "sentAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobStatus_property_startTime_idx"     ON dexcron."jobStatus"      ("propertyId", "startTime");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cards_property_userId_idx"            ON dexpatron.cards          ("propertyId", "userId");
```
`userSessions` and `deviceInfos` already have suitable indexes.

### 6.3 Migrations

Run in order, each in one transaction:
```bash
for m in 001_analytics_rollups 002_engagement 003_dextrans; do
  PGOPTIONS='-c lock_timeout=10s -c statement_timeout=300s' psql "$DEXL" -X -v ON_ERROR_STOP=1 -q -f db/migrations/$m.sql || break
done
```
- 001 drops the first-generation objects and creates the new pipeline. Creating the triggers takes a brief lock on `data."dexAnalytics"`; ingest waits milliseconds. If the lock times out, rerun.
- 002 queues history for a rebuild only if properties already exist (they don't yet).
- 003 creates the foreign tables but makes no connection yet.

### 6.4 Link `dextrans`

```bash
scripts/link-dextrans.sh <prod>
```
It must run as `<admin>`, the role pg_cron will run as: the user mapping is created for the current role. Expect `link ok: N sessions visible`. To read from a replica instead of the primary, set the replica endpoint first: `DEXTRANS_HOST=<replica endpoint> scripts/link-dextrans.sh <prod>` (the role is created on the primary and replicates).

Check the role in `dextrans`: not superuser, no `CREATEDB`/`CREATEROLE`, connection limit 5, 61 column grants, 0 table grants:
```sql
SELECT rolsuper, rolcreatedb, rolcreaterole, rolconnlimit,
       (SELECT count(*) FROM information_schema.column_privileges WHERE grantee = 'analytics_dextrans_reader') AS column_grants,
       (SELECT count(*) FROM information_schema.table_privileges  WHERE grantee = 'analytics_dextrans_reader') AS table_grants
  FROM pg_roles WHERE rolname = 'analytics_dextrans_reader';
```

### 6.5 Seeds and production configuration

```bash
psql "$DEXL" -X -v ON_ERROR_STOP=1 -f db/seeds/001_event_catalog.sql
```

Exclusions and geofence names **before** the property rows, so the first build already leaves test accounts out:
```sql
INSERT INTO analytics."excludedUser" ("tenantId", "propertyId", "userId", reason) VALUES
    (<tenant>, <property>, '<account uuid>', 'staff'),
    ...;
INSERT INTO analytics."geofenceZone" ("tenantId", "propertyId", "geofenceId", "displayName", "isTest") VALUES
    (<tenant>, <property>, '<geofence_id>', '<name>', false),
    ...;
```

Then one row per property. Inserting it queues that property's whole event history:
```sql
INSERT INTO analytics.property ("tenantId", "propertyId", name, "timeZone", environment)
VALUES (<tenant>, <property>, '<name>', '<IANA zone, e.g. America/Los_Angeles>', 'prod');
```

### 6.6 Backfill

**Event rollups.** Rebuilds newest days first, 30 days per call, until no hour older than 2 hours is left queued (live events keep queueing the current hour, so the queue is never quite empty):
```bash
while [ "$(psql "$DEXL" -X -At -c "SELECT count(*) FROM analytics.\"refreshQueue\" WHERE \"bucketHour\" < now() - interval '2 hours'")" != "0" ]; do
  PGOPTIONS='-c statement_timeout=0' psql "$DEXL" -X -q -c 'CALL analytics."refreshRollups"(30)'
done
```
Time is roughly linear in events: dev rebuilt 12,893 events in 0.5 s. Run off-peak for tens of millions.

**Platform rollups.** One call covers 400 days. Each property is one transaction reading up to 400 days from `dextrans`. If 4.7 showed millions of rows, raise the reader's remote timeout for the backfill and put it back after:
```sql
-- in dextrans, only if needed
ALTER ROLE analytics_dextrans_reader IN DATABASE dextrans SET statement_timeout = '30min';
```
```bash
PGOPTIONS='-c statement_timeout=0' psql "$DEXL" -X -c 'CALL analytics."refreshDextrans"(400, 400)'
```
```sql
-- in dextrans, afterwards
ALTER ROLE analytics_dextrans_reader IN DATABASE dextrans SET statement_timeout = '120s';
```
Check the run: `SELECT kind, status, error, "finishedAt" - "startedAt" FROM analytics."refreshRun" ORDER BY "runId" DESC LIMIT 3;`

### 6.7 Schedule

```bash
psql "$DEXL" -X -v ON_ERROR_STOP=1 -f db/ops/schedule_refresh.sql
```
Re-runnable (jobs are replaced by name). After 15 minutes, both jobs should show successful runs:
```sql
SELECT j.jobname, d.status, d.start_time, d.end_time - d.start_time AS took
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 ORDER BY d.start_time DESC LIMIT 6;
```

### 6.8 Verify

Production runs the environment-neutral checks only (`db/tests/rollup_checks.sql` holds Graton-dev golden values and would fail elsewhere):
```bash
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=0' psql "$DEXL" -X -f db/tests/rollup_invariants.sql
```
```bash
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=0' psql "$DEXL" -X -f db/tests/dextrans_checks.sql
```
Every row must say `PASS` (8 and 10 rows). The invariants scan all raw events, so give them time on large tables. They skip days whose refresh is still queued; `dextrans_checks` compares days before today. If a campaign or tier snapshot row differs by a few, a campaign or card changed since the last refresh: rerun after the next one.

Finally, spot-check one number against the raw table for yesterday, for example sessions started:
```sql
SELECT (SELECT sum("eventCount") FROM analytics."eventDaily" WHERE "propertyId" = <property> AND "eventId" = 'session_started' AND "bucketDate" = current_date - 1) AS rollup,
       (SELECT count(*) FROM data."dexAnalytics" WHERE "propertyId" = <property> AND "eventId" = 'session_started'
           AND ("createdDate" AT TIME ZONE '<zone>')::date = current_date - 1) AS raw;
```

## 7. Phase D: dashboard

### 7.1 Read-only database role for the API

On dev the API uses the admin login with a read-only session. In production give it its own role. In `dexl`, as `<admin>`; `\password` prompts and sends only a SCRAM hash:
```sql
CREATE ROLE analytics_api LOGIN CONNECTION LIMIT 20;
\password analytics_api
ALTER ROLE analytics_api IN DATABASE dexl SET default_transaction_read_only = on;
ALTER ROLE analytics_api IN DATABASE dexl SET statement_timeout = '10s';
GRANT CONNECT ON DATABASE dexl TO analytics_api;
GRANT USAGE ON SCHEMA analytics TO analytics_api;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO analytics_api;
ALTER DEFAULT PRIVILEGES FOR ROLE <admin> IN SCHEMA analytics GRANT SELECT ON TABLES TO analytics_api;
```
It gets no access to `data` (the `refreshStatus` view reads raw events with its owner's rights) or to the `dextrans` foreign tables. Store the password in your secrets manager; the API reads it as part of `DATABASE_URL`.

### 7.2 API

Build: `npm ci && npm run build -w @phub/api`. Run: `node dist/server.js` with Node 24. Configuration (validated at start; the process exits on anything missing):

| Variable | Production value |
|---|---|
| `DATABASE_URL` | `postgres://analytics_api:<password>@<host>:5432/dexl` (from the secrets manager) |
| `DATABASE_SSL` | `require` |
| `APP_ENVIRONMENT` | `prod` |
| `AUTH_MODE` | `jwt` (dev mode is refused outside `dev`) |
| `JWT_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_ROLES_CLAIM` | From the identity provider |
| `ALLOWED_ORIGIN` | Only if the web app is served from another origin |
| `HOST`, `PORT` | `0.0.0.0` and the container port |

Health checks: liveness `GET /healthz`; readiness `GET /readyz` (503 when the event rollups haven't refreshed for 30 minutes). The API never logs request bodies and redacts `authorization` and `cookie` headers.

### 7.3 Web app

Build: `npm run build -w @phub/web` → static files in `apps/web/dist/web/browser`. Serve them on the same origin as `/api` (a reverse proxy, or a backend-for-frontend that holds the session in an HttpOnly cookie and forwards a bearer token). Set a strict Content-Security-Policy: `default-src 'self'` works, since the app has no inline scripts.

### 7.4 Smoke test

1. Sign in with an `analytics:admin` user: all four tabs load, no DEV banner, the freshness line shows times within the last 15 minutes.
2. Sign in with `analytics:marketing` only: Marketing loads; Executive, Engagement and IT are absent, and their API calls return 403.
3. `curl -i https://<api>/api/analytics/executive` without a token returns 401 `application/problem+json`.

## 8. Rollback

Reverse order. Roll back the API and web app first: newer code reads tables these scripts remove. Raw events and `dextrans` data are never touched. All scripts are exercised by `scripts/test-rollback-local.sh`.

| Undo | Commands |
|---|---|
| Dashboard | Redeploy the previous API/web version, or stop it |
| Schedules | `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'analytics-%';` |
| 003 + link | `psql "$DEXL" -f db/rollback/003_dextrans_down.sql`, then `psql "$DEXTRANS" -f db/rollback/dextrans_reader_drop.sql` |
| 002 | `psql "$DEXL" -f db/rollback/002_engagement_down.sql` |
| 001 | `DROP SCHEMA analytics CASCADE;` (also removes the new triggers on the raw table), then `pg_restore -d "$DEXL" analytics-before-001.dump`, then run the `CREATE TRIGGER "dexAnalytics_delta_after_insert" ...` line from `dexAnalytics-before-001.sql` |
| pg_cron | Remove `pg_cron` from `shared_preload_libraries` and reset `cron.database_name` in the parameter group; reboot (only if pg_cron must go entirely) |
| `dextrans` indexes | Keep them; they only help |

## 9. Monitoring and alerts

| Signal | Query or check | Alert when |
|---|---|---|
| Event rollups fresh | `SELECT now() - "lastSuccessAt" FROM analytics."refreshStatus";` or `GET /readyz` | Over 30 minutes |
| Event queue draining | `SELECT now() - "oldestQueuedAt" FROM analytics."refreshStatus";` | Over 30 minutes |
| Platform rollups fresh | `SELECT now() - "dextransRefreshedAt" FROM analytics."refreshStatus";` | Over 60 minutes |
| Refresh failures | `SELECT kind, error, "startedAt" FROM analytics."refreshRun" WHERE status = 'failed' AND "startedAt" > now() - interval '1 hour';` | Any row |
| Hung refresh | `SELECT * FROM analytics."refreshRun" WHERE status = 'running' AND "startedAt" < now() - interval '1 hour';` | Any row |
| pg_cron | `SELECT * FROM cron.job_run_details WHERE status = 'failed' AND start_time > now() - interval '1 hour';` | Any row |
| No new events | `SELECT now() - "latestEventAt" FROM analytics."refreshStatus";` | Over 1 hour in production (app or ingest problem, not analytics) |

`refreshRun` gains one row per run (about 400 a day); it is small, but prune rows older than 90 days in the same daily job if you prefer.

## 10. Operations runbook

| Task | How |
|---|---|
| Rotate the `dextrans` reader password | `scripts/link-dextrans.sh <prod>` (new password on both sides; safe to rerun) |
| Add a property | Insert exclusions and geofences for it, then its `analytics.property` row (6.5); the next 5-minute refresh starts its backfill, newest first; run `CALL analytics."refreshDextrans"(400, 400)` once for its platform history |
| Change a property's time zone | `UPDATE analytics.property SET "timeZone" = '<zone>' WHERE ...;` clears and requeues its event rollups automatically; then `CALL analytics."refreshDextrans"(400, 400)` |
| Exclude a test account | Insert into `analytics."excludedUser"`: event rollups rebuild its days automatically; platform rollups only rebuild the last 3 days, so run `CALL analytics."refreshDextrans"(400, 400)` |
| Correct a campaign's test flag | `INSERT INTO analytics."campaignFlag" ("campaignId", "isTest", reason) VALUES ('<uuid>', false, '<why>');` applies at the next 15-minute refresh |
| Change which events count as activity | `UPDATE analytics."eventCatalog" SET "isForeground" = ... WHERE "eventId" = ...;` requeues all history automatically |
| Add a breakdown | Insert into `analytics."dimensionRule"`; all history is requeued automatically |
| Rebuild everything | `SELECT analytics."markDirty"("tenantId", "propertyId") FROM analytics.property;` then the backfill loop in 6.6, and `CALL analytics."refreshDextrans"(400, 400)` |
| Pause refreshes | `SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE jobname LIKE 'analytics-%';` (`active := true` to resume) |
| Diagnose a failed refresh | The error is in `analytics."refreshRun".error` and in the job's `return_message`; a failed day stays queued and retries on the next run |

## 11. Known limitations and follow-ups

- **No retention or deletion job yet.** Raw events and the guest tables (`guestDaily`, `guestEventDaily`, `guestDeviceDaily`, `accountTier`) hold account IDs. Deleting an account's raw events rebuilds its event rollups automatically, but `guestDeviceDaily` needs `refreshDextrans(400, 400)` or a targeted delete. Build the 13-month retention and deletion job before or soon after launch (plan Phase 7).
- **Tiers are current tiers**, applied to the whole history.
- **Test campaigns and jobs are flagged by name**; production names should not need it, but `campaignFlag` corrects any mistake.
- **No migration ledger.** Record which migrations ran in the change ticket; consider a `schemaMigration` table with the next migration.
- **Platform data-quality issues** listed in `docs/dextrans-review.md` (logging bugs `{ex.Message}` and `{campaign.Id}`, campaigns missing from `campaignMaster`, one trip ID per session) affect the numbers until fixed at the source.
- **Security finding for the platform team:** `dexauth.accounts.otp` stores OTP codes in plain text. Unrelated to analytics, which can't read it.
- **The API has no container image yet**; add one with the hosting decision.

## 12. Before release: tests to run

| Test | Command | Covers |
|---|---|---|
| Unit | `npm test` | API auth, validation, caching, date ranges; insight rules |
| Integration (dev) | `npm run test:integration -w @phub/api` | Plan golden values, DAU/WAU/MAU recount from raw events, platform data vs direct counts |
| Event rollups | `scripts/test-rollups-local.sh` | Fresh install of all migrations, golden values, invariants, idempotency, late events, DST, exclusions, concurrency |
| Link and platform rollups | `scripts/test-dextrans-local.sh` | Link setup, backfill, checks, reader can't see other columns or write, link failure isolation |
| Rollback | `scripts/test-rollback-local.sh` | 003 down/up, 002 down/up, role drop |

## Appendix: reference timings from Graton dev

| Operation | Data | Time |
|---|---|---|
| Migration 001–003 apply | | Under 1 s each |
| Event backfill | 72 days, 12,893 events | 0.5 s |
| Platform backfill (400 days) | 1,121 sessions, 28,682 sends, 9,281 campaign messages, 157,650 job runs | 1.9 s |
| Scheduled event refresh | A few new days | Under 0.2 s |
| Scheduled platform refresh | Last 3 days, campaigns 45 days | 1.1 s |
| pg_cron reboot | Single-AZ dev instance | About 2 min |
