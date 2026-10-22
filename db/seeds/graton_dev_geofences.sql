-- Graton dev geofence display names, taken from the most common geofence_name
-- sent with each geofence_id. Only the two zones the plan names are flagged as
-- tests; confirm the others (staff offices and homes look like tests too).
-- Read at query time: no rollup rebuild needed. Re-runnable.

INSERT INTO analytics."geofenceZone" ("tenantId", "propertyId", "geofenceId", "displayName", "isTest") VALUES
    (15001, 1500001, '1500001-0003-0001', 'Zone A', false),
    (15001, 1500001, '1500001-0003-0002', 'Zone B', false),
    (15001, 1500001, '1500001-0003-0003', 'Zone C', false),
    (15001, 1500001, '1500001-0003-0004', 'Zone D', false),
    (15001, 1500001, '1500001-0006-0001', 'At Graton', false),
    (15001, 1500001, '1500001-0006-0002', 'Driving by Graton', false),
    (15001, 1500001, '1500001-0011-0001', 'Vijay S', false),
    (15001, 1500001, 'Aaraverse office', 'Aaraverse office', true),
    (15001, 1500001, 'Graton', 'Graton', false),
    (15001, 1500001, 'KP''Geo Location', 'KP''Geo Location', true),
    (15001, 1500001, 'KP two', 'KP two', false),
    (15001, 1500001, 'Lab MT', 'Lab MT', false),
    (15001, 1500001, 'MarkerTrax Office', 'MarkerTrax Office', false),
    (15001, 1500001, 'vijay house', 'vijay house', false)
ON CONFLICT ("tenantId", "propertyId", "geofenceId") DO UPDATE
    SET "displayName" = EXCLUDED."displayName", "isTest" = EXCLUDED."isTest";
