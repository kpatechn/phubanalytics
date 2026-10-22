-- Schedule the analytics refresh with pg_cron. Run in database dexl.
-- Prerequisites (RDS parameter group, then reboot):
--   shared_preload_libraries includes pg_cron
--   cron.database_name = dexl
-- Needs rds_superuser. Re-runnable: cron.schedule replaces a job with the same name.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Rebuild queued days every 5 minutes, at most 30 days per run (newest first),
-- so a large backfill catches up over several runs instead of one long one.
SELECT cron.schedule('analytics-refresh', '*/5 * * * *', $$CALL analytics."refreshRollups"(30)$$);

-- dextrans rollups (sessions, devices, delivery, campaigns, tiers, jobs) every 15
-- minutes, on their own job so a dextrans outage never delays the event rollups.
-- Needs migration 003 and scripts/link-dextrans.sh.
SELECT cron.schedule('analytics-dextrans-refresh', '*/15 * * * *', $$CALL analytics."refreshDextrans"()$$);

-- pg_cron logs every run in cron.job_run_details; keep a week.
SELECT cron.schedule('cron-history-purge', '17 3 * * *', $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$);

SELECT jobid, jobname, schedule, command, database, username, active FROM cron.job ORDER BY jobid;
