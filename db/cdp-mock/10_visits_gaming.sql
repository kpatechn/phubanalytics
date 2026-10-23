-- MOCK DATA: visits at every site, and gaming at the sites other than WinStar.
--
-- cdp_mock.visit is the backbone the other mock files hang activity on:
--   WinStar: one visit per real trip in the WinStar sample (trip_ws) inside the window, so
--            mocked hotel, dining, spa and golf at WinStar line up with real gaming days.
--   Others:  mocked from each player's home region, tier and spend index.
-- Gaming rows are written only for the mocked sites, in the WinStar table shapes
-- (dexiga.customer_gaming_activity_summary and dexiga.customer_slot_rating) with that
-- site's property ID, plus mock_visit_id. WinStar's own gaming stays in dexiga.

BEGIN;

CREATE TABLE cdp_mock.visit (
    visit_id       bigint PRIMARY KEY,
    account_number numeric NOT NULL REFERENCES cdp_mock.player,
    site_code      text NOT NULL REFERENCES cdp_mock.site,
    visit_date     date NOT NULL,
    arrival_time   time NOT NULL,
    nights         integer NOT NULL,      -- 0 = day trip
    party_size     integer NOT NULL,
    room_comped    boolean NOT NULL,      -- overnight at a hotel site and the room was comped
    source         text NOT NULL CHECK (source IN ('winstar_real_trip', 'mock')),
    UNIQUE (account_number, site_code, visit_date)
);

CREATE TEMP TABLE visit_stage ON COMMIT DROP AS
-- WinStar: real trip days. tstrpas is the start time as HHMMSS when it is a valid time.
SELECT DISTINCT ON (t.acctpas, t.svalpas)
       t.acctpas::numeric AS account_number,
       'WINSTAR'::text AS site_code,
       date '1899-12-30' + t.svalpas AS visit_date,
       CASE WHEN t.tstrpas BETWEEN 1 AND 235959 AND t.tstrpas / 100 % 100 < 60 AND t.tstrpas % 100 < 60
            THEN make_time(t.tstrpas / 10000, t.tstrpas / 100 % 100, t.tstrpas % 100)
       END AS arrival_time,
       greatest(t.dsplpas - 1, 0)::integer AS real_extra_days,
       'winstar_real_trip'::text AS source
FROM dexiga.customer_gaming_activity_summary_trip_ws t
JOIN cdp_mock.player pl ON pl.account_number = t.acctpas
CROSS JOIN cdp_mock.params p
WHERE t.svalpas BETWEEN cdp_mock.day_number(p.start_date) AND cdp_mock.day_number(p.end_date)
ORDER BY t.acctpas, t.svalpas, t.tstrpas, t.dsplpas DESC;

-- Other sites: does the player visit at all (pull), how often (exponential around
-- visits_mean, more for higher tiers and for Oklahoma locals), and on which days
-- (uniform, with a third of Monday-Wednesday visits moved to Friday).
INSERT INTO visit_stage
WITH pair AS (
    SELECT pl.account_number, pl.home_region, s.site_code, s.visits_mean, t.visit_factor,
           CASE pl.home_region WHEN 'TX' THEN s.pull_tx WHEN 'OK' THEN s.pull_ok ELSE s.pull_other END
               * (1 + 0.25 * (t.tier_rank - 1)) AS pull
    FROM cdp_mock.player pl
    JOIN cdp_mock.tier t USING (card_level)
    CROSS JOIN cdp_mock.site s
    WHERE s.gaming_source = 'mock'
),
visiting AS (
    SELECT account_number, site_code,
           least(60, greatest(1, round(cdp_mock.expo('visits:' || account_number || ':' || site_code,
                visits_mean * visit_factor * CASE home_region WHEN 'OK' THEN 1.5 ELSE 0.5 END))))::integer AS n_visits
    FROM pair
    WHERE cdp_mock.u('pull:' || account_number || ':' || site_code) < pull
),
drawn AS (
    SELECT v.account_number, v.site_code, g,
           p.start_date + floor(cdp_mock.u('day:' || v.account_number || ':' || v.site_code || ':' || g)
                                * (p.end_date - p.start_date + 1))::integer AS d,
           p.end_date
    FROM visiting v
    CROSS JOIN cdp_mock.params p
    CROSS JOIN LATERAL generate_series(1, v.n_visits) g
)
SELECT account_number, site_code,
       CASE WHEN extract(isodow FROM d) IN (1, 2, 3)
                 AND cdp_mock.u('weekend:' || account_number || ':' || site_code || ':' || g) < 0.35
            THEN least(end_date, d + (5 - extract(isodow FROM d))::integer)
            ELSE d END,
       NULL::time, 0, 'mock'
FROM drawn;

INSERT INTO cdp_mock.visit
SELECT row_number() OVER (ORDER BY v.visit_date, s.site_no, v.account_number),
       v.account_number, v.site_code, v.visit_date,
       coalesce(v.arrival_time, cdp_mock.clock('arrive:' || v.account_number || ':' || v.site_code || ':' || v.visit_date, 9, 16)),
       v.nights,
       1 + (cdp_mock.u('party1:' || v.account_number || ':' || v.visit_date) < 0.45)::integer
         + (cdp_mock.u('party2:' || v.account_number || ':' || v.visit_date) < 0.10)::integer,
       v.nights > 0 AND cdp_mock.u('roomcomp:' || v.account_number || ':' || v.site_code || ':' || v.visit_date)
                        < CASE t.tier_rank WHEN 1 THEN 0.10 WHEN 2 THEN 0.50 ELSE 0.90 END,
       v.source
FROM (
    -- Overnight only at hotel sites: likelier for players from further away and higher tiers.
    -- A real WinStar trip that spanned several days keeps that length.
    SELECT st.account_number, st.site_code, st.visit_date, st.arrival_time, st.source,
           CASE WHEN s.hotel_system IS NULL THEN 0
                WHEN st.real_extra_days > 0 THEN least(st.real_extra_days, 4)
                WHEN cdp_mock.u('overnight:' || st.account_number || ':' || st.site_code || ':' || st.visit_date)
                     < CASE pl.home_region WHEN 'OK' THEN 0.05 WHEN 'TX' THEN CASE st.site_code WHEN 'WINSTAR' THEN 0.15 ELSE 0.35 END ELSE 0.50 END
                       + 0.10 * (t.tier_rank - 1)
                THEN least(4, 1 + floor(cdp_mock.expo('nights:' || st.account_number || ':' || st.visit_date, 0.6))::integer)
                ELSE 0 END AS nights
    FROM (SELECT DISTINCT ON (account_number, site_code, visit_date) * FROM visit_stage
          ORDER BY account_number, site_code, visit_date, source DESC) st
    JOIN cdp_mock.site s USING (site_code)
    JOIN cdp_mock.player pl USING (account_number)
    JOIN cdp_mock.tier t USING (card_level)
) v
JOIN cdp_mock.site s USING (site_code)
JOIN cdp_mock.player pl USING (account_number)
JOIN cdp_mock.tier t USING (card_level);

CREATE INDEX ON cdp_mock.visit (account_number);
CREATE INDEX ON cdp_mock.visit (site_code, visit_date);

-- Per-visit play at the mocked sites. Slots: about 6 spins a minute and a 5.5-7% hold.
-- Tables: about 50 hands an hour at a 1.6% edge. Win/loss is from the player's side
-- (negative = player lost), as most WinStar sample values are; about 7 in 10 trips lose.
CREATE TEMP TABLE trip_stage ON COMMIT DROP AS
WITH v AS (
    SELECT v.*, s.site_no, s.loyalty_corporate_id, s.loyalty_property_id, s.has_tables, s.slot_assets, s.nightly_rate,
           pl.card_level, pl.value_index, t.tier_code, t.tier_rank, t.theo_per_day,
           least(v.nights + 1, 4) AS days_played,
           row_number() OVER (PARTITION BY v.account_number, v.site_code ORDER BY v.visit_date) AS trip_number,
           cdp_mock.u('mix:' || v.visit_id) AS mix
    FROM cdp_mock.visit v
    JOIN cdp_mock.site s USING (site_code)
    JOIN cdp_mock.player pl USING (account_number)
    JOIN cdp_mock.tier t USING (card_level)
    WHERE s.gaming_source = 'mock'
),
play AS (
    SELECT v.*, g.game_type,
           CASE WHEN v.has_tables AND v.mix < 0.14 AND v.mix >= 0.08 THEN true ELSE false END AS played_both
    FROM v
    CROSS JOIN LATERAL (VALUES ('Slot'), ('Table')) g(game_type)
    WHERE (g.game_type = 'Slot'  AND NOT (v.has_tables AND v.mix < 0.08))
       OR (g.game_type = 'Table' AND v.has_tables AND v.mix < 0.14)
),
sized AS (
    SELECT p.*,
           greatest(15, least(600, round(CASE p.game_type WHEN 'Slot' THEN 115 ELSE 150 END
                                         * exp(0.5 * cdp_mock.n('mins:' || p.visit_id || p.game_type)))))::integer
               * p.days_played AS minutes,
           (p.theo_per_day * p.value_index * exp(0.3 * cdp_mock.n('theo:' || p.visit_id)) * p.days_played
               * CASE WHEN p.played_both THEN CASE p.game_type WHEN 'Slot' THEN 0.6 ELSE 0.4 END
                      WHEN p.game_type = 'Table' THEN 1.3 ELSE 1 END)::numeric AS theo,
           (0.055 + 0.015 * cdp_mock.u('hold:' || p.visit_id))::numeric AS hold,
           (1 + 1.6 * cdp_mock.n('luck:' || p.visit_id || p.game_type))::numeric AS luck,
           -- Comps go on one row per visit: the slot row, or the table row when there are no slots.
           (p.game_type = 'Slot' OR NOT p.played_both) AS carries_comps
    FROM play p
)
SELECT s.*,
       round(s.theo, 2) AS theo_amount,
       CASE s.game_type WHEN 'Slot' THEN round(s.theo / s.hold) ELSE 0 END AS coin_in,
       CASE s.game_type WHEN 'Slot' THEN round(s.theo / s.hold / (6 * s.minutes), 2)
                        ELSE round(s.theo / (50 * s.minutes / 60.0 * 0.016), 2) END AS average_bet,
       -round(s.theo * s.luck) AS actual_win_loss,
       CASE WHEN s.carries_comps AND cdp_mock.u('compfood:' || s.visit_id) < 0.10 * s.tier_rank + 0.05 * s.nights
            THEN round(15 + cdp_mock.expo('compfoodamt:' || s.visit_id, 35 * s.tier_rank)) ELSE 0 END AS comp_food,
       CASE WHEN s.carries_comps AND cdp_mock.u('compbev:' || s.visit_id) < 0.05 * s.tier_rank
            THEN round(10 + cdp_mock.expo('compbevamt:' || s.visit_id, 15 * s.tier_rank)) ELSE 0 END AS comp_beverage,
       CASE WHEN s.carries_comps AND s.room_comped THEN round(s.nightly_rate * s.nights) ELSE 0 END AS comp_room
FROM sized s;

CREATE TABLE cdp_mock.gaming_trip_summary (
    LIKE dexiga.customer_gaming_activity_summary INCLUDING DEFAULTS,
    mock_visit_id bigint NOT NULL REFERENCES cdp_mock.visit
);
COMMENT ON TABLE cdp_mock.gaming_trip_summary IS
    'MOCK. Trip-level gaming at the non-WinStar sites, in the shape of dexiga.customer_gaming_activity_summary. summary_level T = trip, summary_value = loyalty day number of the trip, summary_grouping S = slots, G = tables (no A all-play rows). rating_points = slot coin-in / 5 or table theo x 0.4.';

INSERT INTO cdp_mock.gaming_trip_summary (
    corporate_id, property_id, account_number, summary_grouping, summary_level, summary_value,
    card_level, tier_code, rating_transaction_type, trip_flag, this_trip_number, play_category_free_wager,
    play_type, game_type, game_id, denomination, property_time, days_count, number_of_trips, days_played,
    number_of_ratings, time_played_minutes, average_bet, max_potential_bet, rating_points, theoretical_loss,
    actual_win_loss, cash_buy_in, credit_buy_in, combined_buy_in, coin_in, coin_out, handle_pulls,
    adjusted_coin_in, adjusted_theoretical_loss, theoretical_coin_in,
    comp_value_issued_beverage, comp_value_issued_food, comp_value_issued_others, comp_value_issued_room,
    number_of_room_nights_comped, comp_value_issued_transport, comp_value_issued_total,
    date_created, time_created, date_modified, time_modified, mock_visit_id)
SELECT loyalty_corporate_id, loyalty_property_id, account_number,
       CASE game_type WHEN 'Slot' THEN 'S' ELSE 'G' END, 'T', cdp_mock.day_number(visit_date)::text,
       card_level, tier_code, CASE game_type WHEN 'Slot' THEN 'SLT' ELSE 'RAT' END, 'Y', trip_number, ' ',
       CASE game_type WHEN 'Slot' THEN 'S' ELSE 'G' END, game_type, '', 0,
       (extract(hour FROM arrival_time) * 10000 + extract(minute FROM arrival_time) * 100)::numeric,
       days_played, 1, days_played,
       CASE game_type WHEN 'Slot' THEN least(20, ceil(minutes / 20.0)) ELSE ceil(minutes / 45.0) END,
       minutes, average_bet, round(average_bet * 1.5, 2),
       CASE game_type WHEN 'Slot' THEN round(coin_in / 5) ELSE round(theo * 0.4) END,
       theo_amount, actual_win_loss,
       CASE game_type WHEN 'Table' THEN round(average_bet * 15) ELSE 0 END, 0,
       CASE game_type WHEN 'Table' THEN round(average_bet * 15) ELSE 0 END,
       coin_in, greatest(coin_in + actual_win_loss, 0) * (game_type = 'Slot')::integer,
       CASE game_type WHEN 'Slot' THEN least(9999999, 6 * minutes) ELSE 0 END,
       coin_in, theo_amount, coin_in,
       comp_beverage, comp_food, 0, comp_room,
       CASE WHEN comp_room > 0 THEN nights ELSE 0 END, 0, comp_beverage + comp_food + comp_room,
       visit_date + days_played - 1, arrival_time, visit_date + days_played - 1, arrival_time, visit_id
FROM trip_stage;

CREATE INDEX ON cdp_mock.gaming_trip_summary (account_number);
CREATE INDEX ON cdp_mock.gaming_trip_summary (property_id, summary_value);
CREATE INDEX ON cdp_mock.gaming_trip_summary (mock_visit_id);

-- Slot ratings: one per ~20 minutes of slot play (at most 20 per trip; WinStar's are
-- ~10 minutes, halved here to keep the table small), coin-in split across them so they add
-- up to the trip, spread over the trip's days. Asset numbers are site_no * 10000 + machine;
-- they repeat WinStar's range because each site's loyalty system numbers its own machines.
CREATE TABLE cdp_mock.slot_rating (
    LIKE dexiga.customer_slot_rating INCLUDING DEFAULTS,
    mock_visit_id bigint NOT NULL REFERENCES cdp_mock.visit
);
COMMENT ON TABLE cdp_mock.slot_rating IS
    'MOCK. Slot ratings at the non-WinStar sites, in the shape of dexiga.customer_slot_rating. coin_in / coin_out are cents; *_dollars_cents are dollars. patron_name is always NULL.';

INSERT INTO cdp_mock.slot_rating (
    corporate_id, property_id, account_number, asset, game_id, game_additional_id, game_number,
    transaction_date_hun_year, slot_denomination, denomination_type, rating_code, time_started, time_stopped,
    patron_name, coin_in, coin_in_dollars_cents, coin_in_meter_type, theoretical_coin_in, coin_out,
    coin_out_dollars_cents, coin_out_meter_type, adjusted_coin_amount, adjusted_theoretical_loss_amount,
    irs_jackpot_dollars, remarks_exists_flag, date_created, time_created, date_modified, time_modified, mock_visit_id)
SELECT loyalty_corporate_id, loyalty_property_id, account_number,
       site_no * 10000 + 1 + floor(cdp_mock.u('asset:' || visit_id || ':' || i) * slot_assets)::integer,
       cdp_mock.pick('game:' || visit_id || ':' || i,
                     '{A2,AG,AL,AM,AP,AT,AV,B9,BB,CG,CH,CJ,EL,G5,GK,IT,KG,LW,MM,NG,SA,UN,VT,WM,Z4,ZI}'),
       '000',
       1 + floor(cdp_mock.u('gamenum:' || visit_id || ':' || i) * 1200)::integer,
       cdp_mock.day_number(rating_date),
       cdp_mock.wpick('denom:' || visit_id || ':' || i,
                      '{0.01,0.02,0.05,0.10,0.25,0.50,1.00,2.00,5.00,10.00,25.00,100.00}',
                      '{75,2,3,2,3,1,8,1,2,1,1,1}')::numeric,
       'T',
       cdp_mock.pick('rcode:' || visit_id || ':' || i, '{R1,R2,R3,R4,R5,R6,R7,R8,R9}'),
       started, started + make_interval(secs => slot_minutes * 60 * 0.9),
       NULL,
       round(rating_coin_in * 100), rating_coin_in, 0, rating_coin_in,
       round(rating_coin_out * 100), rating_coin_out, 0, rating_coin_in, round(rating_coin_in * hold, 2),
       0, 'N', rating_date, started, rating_date, started, visit_id
FROM (
    SELECT r.*,
           round(r.coin_in * r.w / sum(r.w) OVER (PARTITION BY r.visit_id), 2) AS rating_coin_in,
           round(greatest(r.coin_in + r.actual_win_loss, 0) * r.w / sum(r.w) OVER (PARTITION BY r.visit_id), 2) AS rating_coin_out,
           r.visit_date + (r.i - 1) / r.per_day AS rating_date,
           r.arrival_time + make_interval(secs => ((r.i - 1) % r.per_day * r.slot_minutes * 60)::integer) AS started
    FROM (
        SELECT ts.*, i, n.n_ratings, ts.minutes::numeric / n.n_ratings AS slot_minutes,
               ceil(n.n_ratings / ts.days_played::numeric)::integer AS per_day,
               (0.5 + cdp_mock.u('w:' || ts.visit_id || ':' || i))::numeric AS w
        FROM trip_stage ts
        CROSS JOIN LATERAL (SELECT least(20, ceil(ts.minutes / 20.0))::integer AS n_ratings) n
        CROSS JOIN LATERAL generate_series(1, n.n_ratings) i
        WHERE ts.game_type = 'Slot'
    ) r
) x;

CREATE INDEX ON cdp_mock.slot_rating (account_number);
CREATE INDEX ON cdp_mock.slot_rating (property_id, transaction_date_hun_year);

COMMIT;
