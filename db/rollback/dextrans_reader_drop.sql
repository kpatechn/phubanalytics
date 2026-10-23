-- Run in database dextrans after 003's rollback in dexl: removes the read-only
-- role. Revoking table privileges also revokes its column-level grants.

\set ON_ERROR_STOP on

REVOKE ALL ON ALL TABLES IN SCHEMA dexauth, dexcomm, dexcron, dexpatron, phcamp FROM analytics_dextrans_reader;
REVOKE USAGE ON SCHEMA dexauth, dexcomm, dexcron, dexpatron, phcamp FROM analytics_dextrans_reader;
SELECT format('REVOKE CONNECT ON DATABASE %I FROM analytics_dextrans_reader', current_database()) \gexec
SELECT format('ALTER ROLE analytics_dextrans_reader IN DATABASE %I RESET ALL', current_database()) \gexec
DROP ROLE analytics_dextrans_reader;
