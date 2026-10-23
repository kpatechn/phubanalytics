# Rollback

Run in reverse order, newest first. Each script is one transaction (except the role drop) and leaves the earlier migrations working. Roll back the API and web app of the same release before the database: newer code reads tables these scripts remove.

| Undo | Run in | Script | Effect |
|---|---|---|---|
| 003 | `dexl` | `003_dextrans_down.sql` | Unschedules `analytics-dextrans-refresh`; drops platform rollups, foreign tables, server, user mappings, `postgres_fdw` |
| 003 (role) | `dextrans` | `dextrans_reader_drop.sql` | Revokes grants and drops `analytics_dextrans_reader` |
| 002 | `dexl` | `002_engagement_down.sql` | Restores 001's `refreshDay`; drops the foreground columns, index and trigger |
| 001 | `dexl` | restore the pre-change backup | `pg_restore` the `analytics` schema dump taken before 001, and recreate the old `dexAnalytics_delta_after_insert` trigger (see `docs/production-rollout.md`) |

Raw events (`data."dexAnalytics"`) and everything in `dextrans` are never modified by these scripts. All are tested by `scripts/test-rollback-local.sh`.
