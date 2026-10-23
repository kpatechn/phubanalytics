-- Read-only checks on the mock Chickasaw CDP data (schema cdp_mock in dexiga).
-- Lists every check; fails (non-zero exit with ON_ERROR_STOP) when any is not ok.
-- Rows marked "info" describe the data and never fail.

CREATE TEMP TABLE cdp_mock_check (check_name text, ok boolean, detail text);

INSERT INTO cdp_mock_check
WITH p AS (SELECT * FROM cdp_mock.params),
real_accounts AS (
    SELECT trim(account_number)::numeric AS account_number FROM dexiga.customer_master WHERE trim(account_number) ~ '^\d+$'
),
orphans AS (
    SELECT 'gaming_trip_summary' AS t, count(*) AS n FROM cdp_mock.gaming_trip_summary x WHERE NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'slot_rating', count(*) FROM cdp_mock.slot_rating x WHERE NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'hotel_stay', count(*) FROM cdp_mock.hotel_stay x WHERE x.account_number IS NOT NULL AND NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'pos_check', count(*) FROM cdp_mock.pos_check x WHERE x.account_number IS NOT NULL AND NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'spa_appointment', count(*) FROM cdp_mock.spa_appointment x WHERE NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'golf_round', count(*) FROM cdp_mock.golf_round x WHERE NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'consent_event', count(*) FROM cdp_mock.consent_event x WHERE NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
    UNION ALL SELECT 'app_user', count(*) FROM cdp_mock.app_user x WHERE x.account_number IS NOT NULL AND NOT EXISTS (SELECT 1 FROM real_accounts r WHERE r.account_number = x.account_number)
),
rating_totals AS (
    SELECT mock_visit_id, count(*) AS n, sum(coin_in_dollars_cents) AS coin_in FROM cdp_mock.slot_rating GROUP BY 1
),
room_comp AS (
    SELECT g.mock_visit_id, sum(g.comp_value_issued_room) AS gaming, coalesce(max(h.comp_room_revenue), 0) AS hotel
    FROM cdp_mock.gaming_trip_summary g
    LEFT JOIN cdp_mock.hotel_stay h ON h.mock_visit_id = g.mock_visit_id
    GROUP BY 1
),
multi_site AS (
    SELECT account_number FROM cdp_mock.visit GROUP BY 1
    HAVING bool_or(site_code = 'WINSTAR') AND bool_or(site_code <> 'WINSTAR')
),
slot_trips AS (
    SELECT sum(theoretical_loss) / nullif(sum(coin_in), 0) AS hold,
           avg((actual_win_loss < 0)::integer) AS share_losing
    FROM cdp_mock.gaming_trip_summary WHERE summary_grouping = 'S'
)
SELECT 'player base = WinStar patron master',
       (SELECT count(*) FROM cdp_mock.player) = (SELECT count(*) FROM real_accounts),
       (SELECT count(*) FROM cdp_mock.player) || ' players'
UNION ALL
SELECT 'every carded row is a real WinStar account',
       (SELECT sum(n) FROM orphans) = 0,
       coalesce((SELECT string_agg(t || '=' || n, ', ') FROM orphans WHERE n > 0), 'no orphans')
UNION ALL
SELECT 'mocked gaming is never at WinStar (property 1)',
       NOT EXISTS (SELECT 1 FROM cdp_mock.gaming_trip_summary WHERE property_id = '1')
       AND NOT EXISTS (SELECT 1 FROM cdp_mock.slot_rating WHERE property_id = '1'),
       (SELECT string_agg(DISTINCT property_id, ',' ORDER BY property_id) FROM cdp_mock.gaming_trip_summary) || ' (property IDs with mocked gaming)'
UNION ALL
SELECT 'visits inside the window',
       (SELECT bool_and(visit_date BETWEEN p.start_date AND p.end_date) FROM cdp_mock.visit, p),
       (SELECT min(visit_date) || ' .. ' || max(visit_date) FROM cdp_mock.visit)
UNION ALL
SELECT 'slot ratings add up to their trip',
       NOT EXISTS (SELECT 1 FROM cdp_mock.gaming_trip_summary g JOIN rating_totals r USING (mock_visit_id)
                   WHERE g.summary_grouping = 'S' AND (abs(r.coin_in - g.coin_in) > 1 OR r.n <> g.number_of_ratings)),
       (SELECT count(*) FROM rating_totals) || ' slot trips with ratings'
UNION ALL
SELECT 'room comps on gaming trips match the hotel stay',
       NOT EXISTS (SELECT 1 FROM room_comp WHERE gaming <> hotel),
       (SELECT count(*) FILTER (WHERE gaming > 0) FROM room_comp) || ' comped stays at mocked sites'
UNION ALL
SELECT 'slot hold and losing share look like WinStar (5-7.5%, 65-80%)',
       (SELECT hold BETWEEN 0.05 AND 0.075 AND share_losing BETWEEN 0.65 AND 0.80 FROM slot_trips),
       (SELECT round(hold * 100, 1) || '% hold, ' || round(share_losing * 100) || '% of trips lost' FROM slot_trips)
UNION ALL
SELECT 'some players have real WinStar play and mocked play elsewhere',
       (SELECT count(*) FROM multi_site) > 0,
       (SELECT count(*) FROM multi_site) || ' players'
UNION ALL
SELECT 'some uncarded hotel stays carry a known player''s email',
       EXISTS (SELECT 1 FROM cdp_mock.hotel_stay h JOIN cdp_mock.contact_point c ON c.channel = 'email' AND c.value = h.guest_email
               WHERE h.account_number IS NULL),
       (SELECT count(*) FROM cdp_mock.hotel_stay h JOIN cdp_mock.contact_point c ON c.channel = 'email' AND c.value = h.guest_email
        WHERE h.account_number IS NULL) || ' of ' || (SELECT count(*) FROM cdp_mock.hotel_stay WHERE account_number IS NULL) || ' uncarded stays'
UNION ALL
SELECT 'email and SMS consents name the address they apply to',
       NOT EXISTS (SELECT 1 FROM cdp_mock.consent_event WHERE channel IN ('email', 'sms') AND contact_value IS NULL),
       (SELECT count(*) FROM cdp_mock.consent_event) || ' consent events'
UNION ALL
SELECT 'app events belong to known app users, tenant 16001, known sites',
       NOT EXISTS (SELECT 1 FROM cdp_mock.app_event e
                   WHERE e."tenantId" <> 16001
                      OR NOT EXISTS (SELECT 1 FROM cdp_mock.app_user a WHERE a.user_id::text = e."userId")
                      OR NOT EXISTS (SELECT 1 FROM cdp_mock.site s WHERE s.playerhub_property_id = e."propertyId")),
       (SELECT count(*) || ' events, ' || count(DISTINCT "userId") || ' users' FROM cdp_mock.app_event)
UNION ALL
SELECT 'app events inside the window',
       (SELECT bool_and("createdDate" >= cdp_mock.at_site(p.start_date, '00:00') AND "createdDate" < cdp_mock.at_site(p.end_date + 6, '00:00'))
        FROM cdp_mock.app_event, p),
       (SELECT min("createdDate")::date || ' .. ' || max("createdDate")::date FROM cdp_mock.app_event)
UNION ALL
-- info: the CDP must suppress these, the mock doesn't.
SELECT 'info: self-excluded players with a current marketing opt-in', true,
       (SELECT count(DISTINCT c.account_number) FROM cdp_mock.v_consent_current c JOIN cdp_mock.player pl USING (account_number)
        WHERE pl.is_excluded AND c.status = 'opt_in') || ' players';

SELECT check_name AS check, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END AS result, detail FROM cdp_mock_check;

DO $$
DECLARE failed integer;
BEGIN
    SELECT count(*) INTO failed FROM cdp_mock_check WHERE ok IS NOT TRUE;
    IF failed > 0 THEN
        RAISE EXCEPTION '% cdp_mock check(s) failed', failed;
    END IF;
END $$;
