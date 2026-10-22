-- Run in database dexl after migration 003 (scripts/link-dextrans.sh does this).
-- Points the foreign server "dextrans" at the dextrans database and stores the
-- reader's login for the current role, which must be the role pg_cron runs the
-- refresh as. Env: DEXTRANS_HOST, DEXTRANS_PORT, DEXTRANS_DBNAME, DEXTRANS_READER_PASSWORD.

\set ON_ERROR_STOP on
\getenv dx_host DEXTRANS_HOST
\getenv dx_port DEXTRANS_PORT
\getenv dx_db DEXTRANS_DBNAME
\getenv dx_password DEXTRANS_READER_PASSWORD
SET pg_stat_statements.track_utility = off;

-- ALTER SERVER ... OPTIONS needs ADD for a new option and SET for an existing one.
SELECT format('ALTER SERVER dextrans OPTIONS (%s host %L, %s port %L, SET dbname %L)',
              CASE WHEN o.has_host THEN 'SET' ELSE 'ADD' END, :'dx_host',
              CASE WHEN o.has_port THEN 'SET' ELSE 'ADD' END, :'dx_port',
              :'dx_db')
  FROM (SELECT bool_or(opt LIKE 'host=%') AS has_host, bool_or(opt LIKE 'port=%') AS has_port
          FROM pg_foreign_server s LEFT JOIN LATERAL unnest(s.srvoptions) AS opt ON true
         WHERE s.srvname = 'dextrans') o \gexec

SELECT format('CREATE USER MAPPING FOR CURRENT_USER SERVER dextrans OPTIONS (user %L, password %L)',
              'analytics_dextrans_reader', :'dx_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname = 'dextrans' AND usename = current_user) \gexec
SELECT format('ALTER USER MAPPING FOR CURRENT_USER SERVER dextrans OPTIONS (SET user %L, SET password %L)',
              'analytics_dextrans_reader', :'dx_password')
 WHERE EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname = 'dextrans' AND usename = current_user) \gexec

-- Prove the link works with the new login.
SELECT 'link ok: ' || count(*) || ' sessions visible' AS check FROM dextrans."userSessions";
