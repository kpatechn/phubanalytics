-- Read-only checks on the Chickasaw CDP (schema cdp in dexiga), after CALL cdp.refresh().
-- Reconciles every table with its feeds and checks the rules; fails when one is off.
-- Rows marked "info" describe the data and never fail.

CREATE TEMP TABLE cdp_check (check_name text, ok boolean, detail text);

INSERT INTO cdp_check
WITH run AS (SELECT as_of_date, as_of_date - 364 AS from_date FROM cdp.refresh_run WHERE finished_at IS NOT NULL ORDER BY run_id DESC LIMIT 1),
master AS (SELECT trim(account_number)::numeric AS account_number FROM dexiga.customer_master WHERE trim(account_number) ~ '^\d+$'),
winstar_src AS (
    SELECT count(*) AS n, coalesce(sum(round(t.ttwnpas::numeric, 2)), 0) AS theo
    FROM dexiga.customer_gaming_activity_summary_trip_ws t
    JOIN cdp.site s ON s.corporate_id = trim(t.cpidpas) AND s.property_id = trim(t.pridpas::text)
    WHERE trim(t.slvlpas) = 'T' AND t.svalpas > 0 AND trim(t.tytppas) IS DISTINCT FROM 'FUT'
),
winstar_cdp AS (SELECT count(*) AS n, sum(theo) AS theo FROM cdp.gaming_activity WHERE feed_code = 'winstar_gaming'),
mock_src AS (SELECT count(*) AS n, sum(theoretical_loss) AS theo FROM cdp_mock.gaming_trip_summary),
mock_cdp AS (SELECT count(*) AS n, sum(theo) AS theo FROM cdp.gaming_activity WHERE feed_code = 'mock_gaming'),
ng_src AS (
    SELECT (SELECT count(*) FROM cdp_mock.hotel_stay) + (SELECT count(*) FROM cdp_mock.pos_check)
         + (SELECT count(*) FROM cdp_mock.spa_appointment) + (SELECT count(*) FROM cdp_mock.golf_round) AS n
),
played AS (
    SELECT g.account_number, sum(g.theo) AS theo
    FROM cdp.gaming_activity g, run
    WHERE g.activity_date BETWEEN run.from_date AND run.as_of_date AND (g.days_played > 0 OR g.theo > 0)
    GROUP BY 1
),
ng_paid AS (
    SELECT n.account_number, sum(n.paid_amount) AS paid
    FROM cdp.non_gaming_activity n, run
    WHERE n.activity_date BETWEEN run.from_date AND run.as_of_date AND n.status = 'completed' AND n.account_number IS NOT NULL
    GROUP BY 1
)
SELECT 'WinStar trip rows and theo carried over in full',
       (SELECT n FROM winstar_src) = (SELECT n FROM winstar_cdp) AND (SELECT theo FROM winstar_src) = (SELECT theo FROM winstar_cdp),
       (SELECT n || ' rows, $' || theo || ' theo' FROM winstar_cdp)
UNION ALL
SELECT 'mock gaming rows and theo carried over in full',
       (SELECT n FROM mock_src) = (SELECT n FROM mock_cdp) AND (SELECT theo FROM mock_src) = (SELECT theo FROM mock_cdp),
       (SELECT n || ' rows, $' || theo || ' theo' FROM mock_cdp)
UNION ALL
SELECT 'every non-gaming source row carried over',
       (SELECT n FROM ng_src) = (SELECT count(*) FROM cdp.non_gaming_activity),
       (SELECT count(*) FROM cdp.non_gaming_activity) || ' rows'
UNION ALL
SELECT 'non-gaming paid = gross - comp - points',
       NOT EXISTS (SELECT 1 FROM cdp.non_gaming_activity WHERE paid_amount <> gross_amount - comp_amount - points_amount),
       (SELECT '$' || sum(paid_amount) || ' paid of $' || sum(gross_amount) || ' gross' FROM cdp.non_gaming_activity WHERE status = 'completed')
UNION ALL
SELECT 'email matches only fill in records that had no card number',
       NOT EXISTS (SELECT 1 FROM cdp.non_gaming_activity n JOIN cdp_mock.hotel_stay h ON n.activity_key = 'stay:' || h.stay_id
                   WHERE n.identity_method = 'email' AND h.account_number IS NOT NULL)
       AND EXISTS (SELECT 1 FROM cdp.non_gaming_activity WHERE identity_method = 'email'),
       (SELECT count(*) FILTER (WHERE identity_method = 'email') || ' matched by email, '
               || count(*) FILTER (WHERE account_number IS NULL) || ' still unknown' FROM cdp.non_gaming_activity)
UNION ALL
SELECT 'one profile per patron master account',
       (SELECT count(*) FROM cdp.player_profile) = (SELECT count(*) FROM master),
       (SELECT count(*) FROM cdp.player_profile) || ' profiles'
UNION ALL
SELECT 'profile theo = gaming theo in the window (patron master accounts)',
       (SELECT sum(theo_12m) FROM cdp.player_profile) = (SELECT coalesce(sum(p.theo), 0) FROM played p JOIN master m USING (account_number)),
       (SELECT '$' || sum(theo_12m) FROM cdp.player_profile)
UNION ALL
SELECT 'profile non-gaming paid = non-gaming paid in the window',
       (SELECT sum(non_gaming_paid_12m) FROM cdp.player_profile) = (SELECT coalesce(sum(n.paid), 0) FROM ng_paid n JOIN master m USING (account_number)),
       (SELECT '$' || sum(non_gaming_paid_12m) FROM cdp.player_profile)
UNION ALL
SELECT 'site summaries add up to the profile',
       (SELECT sum(theo) FROM cdp.player_site_summary s JOIN master m USING (account_number)) = (SELECT sum(theo_12m) FROM cdp.player_profile)
       AND NOT EXISTS (SELECT 1 FROM cdp.player_site_summary WHERE visit_days < trips),
       (SELECT count(*) || ' player-site rows' FROM cdp.player_site_summary)
UNION ALL
SELECT 'home site is one of the sites visited',
       NOT EXISTS (SELECT 1 FROM cdp.player_profile WHERE home_site_code IS NOT NULL AND NOT home_site_code = ANY (site_codes_12m))
       AND NOT EXISTS (SELECT 1 FROM cdp.player_profile WHERE (home_site_code IS NULL) <> (sites_visited_12m = 0)),
       (SELECT count(*) FILTER (WHERE sites_visited_12m >= 2) || ' players at 2+ sites' FROM cdp.player_profile)
UNION ALL
SELECT 'RFM scores 1-5 for active players only',
       NOT EXISTS (SELECT 1 FROM cdp.player_profile
                   WHERE (visit_days_12m > 0) <> (rfm_recency IS NOT NULL)
                      OR rfm_recency NOT BETWEEN 1 AND 5 OR rfm_frequency NOT BETWEEN 1 AND 5 OR rfm_monetary NOT BETWEEN 1 AND 5),
       (SELECT count(*) FILTER (WHERE rfm_recency IS NOT NULL) || ' active players' FROM cdp.player_profile)
UNION ALL
SELECT 'four reachability rows per player',
       (SELECT count(*) FROM cdp.reachability) = 4 * (SELECT count(*) FROM cdp.player_profile),
       (SELECT count(*) || ' rows' FROM cdp.reachability)
UNION ALL
SELECT 'self-excluded players are never reachable',
       NOT EXISTS (SELECT 1 FROM cdp.reachability r JOIN cdp.player_profile p USING (account_number) WHERE p.is_excluded AND r.is_reachable)
       AND NOT EXISTS (SELECT 1 FROM cdp.player_profile WHERE is_excluded AND is_marketable),
       (SELECT count(*) || ' self-excluded players' FROM cdp.player_profile WHERE is_excluded)
UNION ALL
SELECT 'reachable means contact on file and opted in',
       NOT EXISTS (SELECT 1 FROM cdp.reachability
                   WHERE is_reachable <> (reason = 'reachable') OR (is_reachable AND (NOT has_contact OR consent_status <> 'opt_in'))),
       (SELECT string_agg(channel || ' ' || n, ', ' ORDER BY channel)
        FROM (SELECT channel, count(*) FILTER (WHERE is_reachable) AS n FROM cdp.reachability GROUP BY 1) x)
UNION ALL
SELECT 'mock flags follow the feed',
       NOT EXISTS (SELECT 1 FROM cdp.gaming_activity g JOIN cdp.feed f USING (feed_code) WHERE g.is_mock <> f.is_mock)
       AND NOT EXISTS (SELECT 1 FROM cdp.non_gaming_activity n JOIN cdp.feed f USING (feed_code) WHERE n.is_mock <> f.is_mock),
       (SELECT count(*) FILTER (WHERE has_mock_data) || ' profiles use mock data' FROM cdp.player_profile)
UNION ALL
SELECT 'info: real WinStar activity for accounts missing from the patron master sample', true,
       (SELECT count(DISTINCT account_number) || ' accounts (sampling gap; not in profiles)'
        FROM cdp.gaming_activity g WHERE NOT EXISTS (SELECT 1 FROM master m WHERE m.account_number = g.account_number));

-- Segments: every member meets its rule and isn't self-excluded, and nobody who qualifies is missing.
DO $$
DECLARE
    seg record;
    wrong bigint;
    missing bigint;
BEGIN
    FOR seg IN SELECT segment_code, rule FROM cdp.segment ORDER BY sort_order LOOP
        EXECUTE format('SELECT count(*) FROM cdp.segment_member m JOIN cdp.player_profile p USING (account_number)
                        WHERE m.segment_code = %L AND (p.is_excluded OR NOT coalesce((%s), false))', seg.segment_code, seg.rule)
            INTO wrong;
        EXECUTE format('SELECT count(*) FROM cdp.player_profile p
                        WHERE NOT p.is_excluded AND (%s)
                          AND NOT EXISTS (SELECT 1 FROM cdp.segment_member m WHERE m.segment_code = %L AND m.account_number = p.account_number)',
                       seg.rule, seg.segment_code)
            INTO missing;
        INSERT INTO cdp_check VALUES ('segment ' || seg.segment_code || ' matches its rule', wrong = 0 AND missing = 0,
                                      (SELECT count(*) FROM cdp.segment_member WHERE segment_code = seg.segment_code) || ' members');
    END LOOP;
END $$;

SELECT check_name AS check, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END AS result, detail FROM cdp_check;

DO $$
DECLARE failed integer;
BEGIN
    SELECT count(*) INTO failed FROM cdp_check WHERE ok IS NOT TRUE;
    IF failed > 0 THEN
        RAISE EXCEPTION '% cdp check(s) failed', failed;
    END IF;
END $$;
