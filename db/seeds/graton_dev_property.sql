-- Graton, dev environment. Inserting the property queues its full event history;
-- run CALL analytics."refreshRollups"(); afterwards to build the rollups.

INSERT INTO analytics.property ("tenantId", "propertyId", name, "timeZone", environment)
VALUES (15001, 1500001, 'Graton Resort & Casino', 'America/Los_Angeles', 'dev');
