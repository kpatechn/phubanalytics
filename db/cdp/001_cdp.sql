-- Chickasaw CDP prototype, GEM dev database (dexiga). Run through scripts/build-cdp.sh.
--
-- Schema cdp holds only derived data: CALL cdp.refresh() rebuilds every table from the
-- feeds, so this file drops and recreates the schema. Feeds today:
--   real  WinStar loyalty sample in dexiga (patron master, tiers, exclusions, trip summaries)
--   mock  everything else, from schema cdp_mock (scripts/mock-chickasaw.sh)
-- The feed SQL lives inside cdp.refresh(), not in views, so rebuilding cdp_mock never drops
-- anything here; replacing a mock feed with a real one means editing that one section.
-- Every activity row says which feed it came from and whether it is mock.

BEGIN;

DO $$
BEGIN
    IF current_database() <> 'dexiga' THEN
        RAISE EXCEPTION 'cdp belongs in the GEM dev database dexiga (connected to %)', current_database();
    END IF;
END $$;

DROP SCHEMA IF EXISTS cdp CASCADE;
CREATE SCHEMA cdp;
COMMENT ON SCHEMA cdp IS
    'Chickasaw CDP prototype (db/cdp in phubanalytics). Derived from WinStar data in dexiga plus mock feeds in cdp_mock. Rebuild with CALL cdp.refresh().';

-- ---------------------------------------------------------------- reference

CREATE TABLE cdp.feed (
    feed_code   text PRIMARY KEY,
    area        text NOT NULL,
    source      text NOT NULL,
    is_mock     boolean NOT NULL,
    notes       text NOT NULL
);
INSERT INTO cdp.feed VALUES
    ('winstar_patrons', 'profile',    'dexiga.customer_master, customer_club_level, exclusion_history', false, 'WinStar patron master sample, standing in for the synced enterprise list'),
    ('winstar_gaming',  'gaming',     'dexiga.customer_gaming_activity_summary_trip_ws',                false, 'WinStar trip summaries (DB2 CFPPAS), decoded in cdp.refresh()'),
    ('winstar_ratings', 'gaming',     'dexiga.customer_slot_rating',                                    false, 'WinStar slot ratings, for game and denomination preferences'),
    ('winstar_loyalty', 'loyalty',    'dexiga.host_customer_relation, rep_host_master, customer_bucket_level_summary; dexiga_main.loyalty_acsc_cfpah_ws, loyalty_acsc_cfpclva_ws', false, 'WinStar hosts, points and rewards, lifetime file and tier thresholds'),
    ('mock_sites',      'reference',  'cdp_mock.site',                                                  true,  'Site list is real; property IDs, PlayerHub IDs and systems are placeholders'),
    ('mock_tiers',      'profile',    'cdp_mock.player',                                                true,  'Tier for accounts missing from the club-level sample'),
    ('mock_gaming',     'gaming',     'cdp_mock.gaming_trip_summary, cdp_mock.slot_rating',             true,  'Gaming at the seven non-WinStar sites'),
    ('mock_hotel',      'non_gaming', 'cdp_mock.hotel_stay',                                            true,  'Agilysys LMS / Stay / Versa stand-in'),
    ('mock_pos',        'non_gaming', 'cdp_mock.pos_check, cdp_mock.outlet',                            true,  'Dining and retail stand-in'),
    ('mock_spa',        'non_gaming', 'cdp_mock.spa_appointment',                                       true,  'Agilysys Spa stand-in'),
    ('mock_golf',       'non_gaming', 'cdp_mock.golf_round',                                            true,  'Agilysys Golf stand-in'),
    ('mock_contacts',   'identity',   'cdp_mock.contact_point',                                         true,  'Email and mobile on file'),
    ('mock_consent',    'consent',    'cdp_mock.v_consent_current',                                     true,  'Opt-ins; Chickasaw keeps none yet'),
    ('mock_app',        'app',        'cdp_mock.app_user, cdp_mock.app_event',                          true,  'Chickasaw app users and events');

-- Settings. as_of_date: the day "last 12 months" ends; empty = latest activity date.
CREATE TABLE cdp.setting (
    key   text PRIMARY KEY,
    value text
);
INSERT INTO cdp.setting VALUES ('as_of_date', NULL);

CREATE TABLE cdp.site (
    site_code             text PRIMARY KEY,
    site_name             text NOT NULL,
    city                  text NOT NULL,
    corporate_id          text NOT NULL,
    property_id           text NOT NULL,
    playerhub_property_id integer,
    time_zone             text NOT NULL,
    gaming_feed           text NOT NULL REFERENCES cdp.feed,
    UNIQUE (corporate_id, property_id)
);

-- ---------------------------------------------------------------- activity

-- One row per source trip summary row. Money in dollars. casino_win > 0 means the player
-- lost (the source's win/loss is from the player's side). game_type: slot, table, or mixed
-- (WinStar 'A' all-play rows, which are also the only WinStar rows carrying comps).
CREATE TABLE cdp.gaming_activity (
    activity_key       text PRIMARY KEY,
    account_number     numeric NOT NULL,
    site_code          text NOT NULL REFERENCES cdp.site,
    activity_date      date NOT NULL,
    trip_start         time,
    game_type          text NOT NULL CHECK (game_type IN ('slot', 'table', 'mixed')),
    rating_type        text,
    days_played        integer NOT NULL,
    minutes_played     integer NOT NULL,
    ratings            integer NOT NULL,
    average_bet        numeric(14,2) NOT NULL,
    coin_in            numeric(16,2) NOT NULL,
    coin_out           numeric(16,2) NOT NULL,
    theo               numeric(14,2) NOT NULL,
    casino_win         numeric(14,2) NOT NULL,
    rating_points      numeric(16,0) NOT NULL,
    comp_food          numeric(12,2) NOT NULL,
    comp_beverage      numeric(12,2) NOT NULL,
    comp_room          numeric(12,2) NOT NULL,
    comp_other         numeric(12,2) NOT NULL,
    comp_total         numeric(12,2) NOT NULL,
    room_nights_comped integer NOT NULL,
    feed_code          text NOT NULL REFERENCES cdp.feed,
    is_mock            boolean NOT NULL
);
CREATE INDEX ON cdp.gaming_activity (account_number, activity_date);
CREATE INDEX ON cdp.gaming_activity (site_code, activity_date);

-- One row per hotel stay, check, spa service or golf round. Amounts exclude tax and tips.
-- gross = value of what was sold; comp and points = how much of it the casino paid for;
-- paid = gross - comp - points. Cancelled and no-show rows are kept with their status.
-- identity_method: card (Club Passport number on the record), email (no number, but the
-- guest's email belongs to exactly one player), or NULL (unknown guest).
CREATE TABLE cdp.non_gaming_activity (
    activity_key    text PRIMARY KEY,
    activity_type   text NOT NULL CHECK (activity_type IN ('hotel', 'dining', 'retail', 'spa', 'golf')),
    site_code       text NOT NULL REFERENCES cdp.site,
    source_system   text NOT NULL,
    account_number  numeric,
    identity_method text CHECK (identity_method IN ('card', 'email')),
    activity_date   date NOT NULL,
    activity_at     timestamptz NOT NULL,
    status          text NOT NULL CHECK (status IN ('completed', 'cancelled', 'no_show')),
    gross_amount    numeric(12,2) NOT NULL,
    comp_amount     numeric(12,2) NOT NULL,
    points_amount   numeric(12,2) NOT NULL,
    paid_amount     numeric(12,2) NOT NULL,
    nights          integer,
    covers          integer,
    detail          text,
    stay_key        text,
    feed_code       text NOT NULL REFERENCES cdp.feed,
    is_mock         boolean NOT NULL
);
CREATE INDEX ON cdp.non_gaming_activity (account_number, activity_date);
CREATE INDEX ON cdp.non_gaming_activity (site_code, activity_date);

-- ---------------------------------------------------------------- identity

-- Identifiers that point to a Club Passport account. Emails are lower-cased. An email
-- or mobile shared by more than one account is kept but never used for matching.
CREATE TABLE cdp.identity_link (
    identifier_type  text NOT NULL CHECK (identifier_type IN ('email', 'mobile', 'app_user')),
    identifier_value text NOT NULL,
    account_number   numeric NOT NULL,
    is_verified      boolean NOT NULL,
    first_seen_at    timestamptz,
    feed_code        text NOT NULL REFERENCES cdp.feed,
    PRIMARY KEY (identifier_type, identifier_value, account_number)
);
CREATE INDEX ON cdp.identity_link (account_number);

-- ---------------------------------------------------------------- loyalty and preferences

-- Tier thresholds: tier points needed to reach (low_points) each tier. Tier and points are
-- shared across sites, so one site's loyalty system is enough; today that is WinStar's.
CREATE TABLE cdp.tier_rule (
    card_level  integer PRIMARY KEY,
    tier_name   text NOT NULL,
    tier_rank   integer NOT NULL UNIQUE,
    low_points  numeric(14,0) NOT NULL,
    high_points numeric(14,0)            -- NULL for the top tier
);

-- Host assignments, per site. host_name comes from the rep master (staff names).
CREATE TABLE cdp.player_host (
    account_number    numeric NOT NULL,
    site_code         text NOT NULL REFERENCES cdp.site,
    rep_code          integer NOT NULL,
    host_name         text,
    is_permanent      boolean NOT NULL,
    next_arrival_date date,
    PRIMARY KEY (account_number, site_code, rep_code)
);

-- Loyalty account figures from the lifetime file (CFPAH) and the point buckets. NULL where
-- the WinStar sample has no row for the player. Rewards are dollars; a balance can't be
-- derived from the sample (redemptions exceed earnings for many players), so none is kept.
-- CFPAH decode: ltdtah trips, ttwlah win/loss (player side), ltdcah comps (sentinels below 0
-- dropped), acelah / acwlah action cash earned / used, lvptah tier points, lvdtah tier
-- expiry, dtaah date added, dtlaah last activity (dates as days since 1899-12-30).
CREATE TABLE cdp.player_loyalty (
    account_number            numeric PRIMARY KEY,
    member_since              date,
    last_activity_date        date,
    lifetime_trips            integer,
    lifetime_casino_win       numeric(16,2),
    lifetime_comps            numeric(16,2),
    action_cash_earned        numeric(14,2),
    action_cash_used          numeric(14,2),
    tier_points               numeric(14,0),
    tier_expires              date,
    points_lifetime           numeric(16,0),
    points_year               numeric(16,0),
    points_year_label         text,
    rewards_earned_lifetime   numeric(14,2),
    rewards_redeemed_lifetime numeric(14,2),
    rewards_adjusted_lifetime numeric(14,2),
    rewards_expired_lifetime  numeric(14,2),
    rewards_earned_year       numeric(14,2),
    rewards_redeemed_year     numeric(14,2)
);

-- What each player plays and when, over the 12 months. Game and denomination by slot coin-in
-- (WinStar's real ratings plus the mocked sites'); weekday and time of day by gaming trips.
-- Game names aren't loaded in GEM (games master empty), so games are the loyalty system's codes.
CREATE TABLE cdp.player_preference (
    account_number      numeric PRIMARY KEY,
    top_game            text,
    top_game_share      numeric(5,4),
    top_denomination    numeric(9,2),
    top_denomination_share numeric(5,4),
    slot_ratings        integer NOT NULL,
    favorite_weekday    integer,         -- ISO: 1 Monday .. 7 Sunday
    weekday_share       numeric(5,4),
    favorite_daypart    text CHECK (favorite_daypart IN ('morning', 'afternoon', 'evening', 'late night')),
    daypart_share       numeric(5,4)
);

-- ---------------------------------------------------------------- player views

-- Last 12 months per player and site.
CREATE TABLE cdp.player_site_summary (
    account_number      numeric NOT NULL,
    site_code           text NOT NULL REFERENCES cdp.site,
    visit_days          integer NOT NULL,   -- days with any completed activity
    trips               integer NOT NULL,   -- gaming trips
    gaming_days         integer NOT NULL,
    theo                numeric(14,2) NOT NULL,
    casino_win          numeric(14,2) NOT NULL,
    comps_issued        numeric(14,2) NOT NULL,
    non_gaming_paid     numeric(14,2) NOT NULL,
    non_gaming_comp     numeric(14,2) NOT NULL,
    first_visit_date    date,
    last_visit_date     date,
    PRIMARY KEY (account_number, site_code)
);

-- One row per Club Passport account. "_12m" = the 12 months ending as_of_date.
CREATE TABLE cdp.player_profile (
    account_number        numeric PRIMARY KEY,
    as_of_date            date NOT NULL,
    tier_name             text NOT NULL,
    tier_rank             integer NOT NULL,
    tier_source           text NOT NULL,
    residential_state     text,
    home_region           text NOT NULL,
    signup_date           date NOT NULL,
    tenure_days           integer NOT NULL,
    is_excluded           boolean NOT NULL,
    home_site_code        text REFERENCES cdp.site,
    sites_visited_12m     integer NOT NULL,
    site_codes_12m        text[] NOT NULL,
    first_activity_date   date,
    last_activity_date    date,
    last_gaming_date      date,
    recency_days          integer,
    visit_days_12m        integer NOT NULL,
    trips_12m             integer NOT NULL,
    gaming_days_12m       integer NOT NULL,
    theo_12m              numeric(14,2) NOT NULL,
    adt_12m               numeric(14,2),        -- average daily theo
    casino_win_12m        numeric(14,2) NOT NULL,
    slot_theo_share       numeric(5,4),
    comps_issued_12m      numeric(14,2) NOT NULL,
    reinvestment_rate     numeric(12,4),        -- gaming comps / theo
    hotel_stays_12m       integer NOT NULL,
    hotel_nights_12m      integer NOT NULL,
    hotel_paid_12m        numeric(14,2) NOT NULL,
    dining_paid_12m       numeric(14,2) NOT NULL,
    retail_paid_12m       numeric(14,2) NOT NULL,
    spa_paid_12m          numeric(14,2) NOT NULL,
    golf_paid_12m         numeric(14,2) NOT NULL,
    non_gaming_paid_12m   numeric(14,2) NOT NULL,
    non_gaming_comp_12m   numeric(14,2) NOT NULL,
    non_gaming_share      numeric(5,4),         -- non-gaming paid / (non-gaming paid + theo)
    combined_value_12m    numeric(14,2) NOT NULL,  -- theo + non-gaming paid
    rfm_recency           integer,              -- 1-5 among players active in the 12 months
    rfm_frequency         integer,
    rfm_monetary          integer,
    app_user_id           uuid,
    app_linked_at         timestamptz,
    app_active_days_90d   integer NOT NULL,
    app_last_active_at    timestamptz,
    reachable_channels    text[] NOT NULL,
    is_marketable         boolean NOT NULL,
    has_mock_data         boolean NOT NULL,
    -- From cdp.player_host, cdp.player_loyalty, cdp.tier_rule and cdp.player_preference.
    host_rep_code         integer,              -- permanent host first, then any
    host_name             text,
    tier_points           numeric(14,0),
    keep_tier_points      numeric(14,0),        -- points the current tier needs
    next_tier_name        text,
    next_tier_points      numeric(14,0),
    points_to_next_tier   numeric(14,0),
    tier_expires          date,
    lifetime_trips        integer,
    lifetime_casino_win   numeric(16,2),
    top_game              text,
    top_denomination      numeric(9,2),
    favorite_weekday      integer,
    favorite_daypart      text
);
CREATE INDEX ON cdp.player_profile (home_site_code);

-- Can we market to this player on this channel, and if not, why not. The first reason
-- that applies wins: self_excluded, no_contact, opted_out, no_consent.
CREATE TABLE cdp.reachability (
    account_number numeric NOT NULL,
    channel        text NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'mail')),
    has_contact    boolean NOT NULL,
    consent_status text NOT NULL CHECK (consent_status IN ('opt_in', 'opt_out', 'none')),
    consent_at     timestamptz,
    is_reachable   boolean NOT NULL,
    reason         text NOT NULL CHECK (reason IN ('reachable', 'self_excluded', 'no_contact', 'opted_out', 'no_consent')),
    PRIMARY KEY (account_number, channel)
);

-- Segments are rules over cdp.player_profile, evaluated by cdp.refresh(). Self-excluded
-- players are never members of any segment.
CREATE TABLE cdp.segment (
    segment_code text PRIMARY KEY,
    name         text NOT NULL,
    description  text NOT NULL,
    rule         text NOT NULL,     -- SQL condition on cdp.player_profile
    sort_order   integer NOT NULL
);
INSERT INTO cdp.segment VALUES
    ('champions',            'Champions',                    'Recent, frequent and high value',                                  'rfm_recency >= 4 AND rfm_frequency >= 4 AND rfm_monetary >= 4', 10),
    ('high_value_at_risk',   'High value at risk',           'Top-two value quintiles, but in the two least recent',             'rfm_monetary >= 4 AND rfm_recency <= 2', 20),
    ('hosted_going_quiet',   'Hosted players going quiet',   'Players with a host, in the two least recent quintiles',           'host_rep_code IS NOT NULL AND rfm_recency <= 2', 25),
    ('new_players',          'New players',                  'Signed up in the last 90 days',                                    'tenure_days < 90', 30),
    ('one_visit',            'One visit, not back',          'One visit day in 12 months, more than 60 days ago',                'visit_days_12m = 1 AND recency_days > 60', 40),
    ('lapsed',               'Lapsed',                       'Members for a year or more with no activity in 12 months',         'visit_days_12m = 0 AND tenure_days >= 365', 50),
    ('multi_site',           'Multi-site players',           'Activity at two or more sites in 12 months',                       'sites_visited_12m >= 2', 60),
    ('near_next_tier',       'Close to the next tier',       'Within 20% of the next tier''s tier points',                       'points_to_next_tier > 0 AND points_to_next_tier <= next_tier_points * 0.2', 65),
    ('ok_winstar_only',      'Oklahomans who only visit WinStar', 'Oklahoma residents whose only site in 12 months is WinStar', 'home_region = ''OK'' AND site_codes_12m = ARRAY[''WINSTAR'']', 70),
    ('hotel_guests',         'Hotel guests',                 'At least one completed stay in 12 months',                         'hotel_stays_12m >= 1', 80),
    ('non_gaming_led',       'Non-gaming led',               'Non-gaming is 40%+ of value, and at least $200 paid',              'non_gaming_paid_12m >= 200 AND non_gaming_share >= 0.4', 90),
    ('app_dormant',          'App users gone quiet',         'Linked app users with no app activity in 90 days',                 'app_user_id IS NOT NULL AND app_active_days_90d = 0', 100),
    ('top_value_no_app',     'Top value without the app',    'Top value quintile with no linked app account',                    'rfm_monetary = 5 AND app_user_id IS NULL', 110),
    ('active_unreachable',   'Active but unreachable',       'Active in 12 months with no channel we may market on',             'visit_days_12m > 0 AND NOT is_marketable', 120);

CREATE TABLE cdp.segment_member (
    segment_code   text NOT NULL REFERENCES cdp.segment ON DELETE CASCADE,
    account_number numeric NOT NULL REFERENCES cdp.player_profile ON DELETE CASCADE,
    PRIMARY KEY (segment_code, account_number)
);
CREATE INDEX ON cdp.segment_member (account_number);

CREATE TABLE cdp.refresh_run (
    run_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz,
    as_of_date  date,
    row_counts  jsonb
);

-- ---------------------------------------------------------------- refresh

CREATE PROCEDURE cdp.refresh()
LANGUAGE plpgsql
AS $proc$
DECLARE
    v_run_id bigint;
    v_as_of  date;
    v_from   date;
    seg      record;
BEGIN
    INSERT INTO cdp.refresh_run (started_at) VALUES (clock_timestamp()) RETURNING run_id INTO v_run_id;

    TRUNCATE cdp.segment_member, cdp.reachability, cdp.player_profile, cdp.player_site_summary,
             cdp.player_preference, cdp.player_loyalty, cdp.player_host, cdp.tier_rule,
             cdp.identity_link, cdp.non_gaming_activity, cdp.gaming_activity, cdp.site;

    -- Sites. Feed: mock_sites.
    INSERT INTO cdp.site
    SELECT site_code, site_name, city, loyalty_corporate_id, loyalty_property_id, playerhub_property_id, time_zone,
           CASE gaming_source WHEN 'real' THEN 'winstar_gaming' ELSE 'mock_gaming' END
    FROM cdp_mock.site;

    -- Loyalty extras. Feed: winstar_loyalty (real). Only rows whose corporate + property ID
    -- belongs to a known site are used.
    INSERT INTO cdp.tier_rule
    SELECT crlvclva::integer, trim(crdsclva), rank() OVER (ORDER BY lovaclva), lovaclva, nullif(hivaclva, 9999999)
    FROM dexiga_main.loyalty_acsc_cfpclva_ws
    WHERE trim(statclva) = 'A';

    INSERT INTO cdp.player_host
    SELECT DISTINCT ON (h.account_number, s.site_code, h.rep_code)
           h.account_number, s.site_code, h.rep_code::integer,
           nullif(concat_ws(' ', nullif(trim(r.rep_first_name), ''), nullif(trim(r.rep_last_name), '')), ''),
           trim(h.permanently_assigned_yn) IS NOT DISTINCT FROM 'Y',
           CASE WHEN h.next_arrival_date > 0 THEN date '1899-12-30' + h.next_arrival_date::integer END
    FROM dexiga.host_customer_relation h
    JOIN cdp.site s ON s.corporate_id = trim(h.corporate_id) AND s.property_id = trim(h.property_id)
    LEFT JOIN dexiga.rep_host_master r
           ON r.rep_code = h.rep_code AND trim(r.corporate_id) = trim(h.corporate_id) AND trim(r.property_id) = trim(h.property_id)
    ORDER BY h.account_number, s.site_code, h.rep_code, h.date_modified DESC NULLS LAST, h.time_modified DESC NULLS LAST;

    INSERT INTO cdp.player_loyalty
    WITH lifetime AS (
        SELECT DISTINCT ON (a.acctah)
               a.acctah AS account_number,
               CASE WHEN a.dtaah > 0 THEN date '1899-12-30' + a.dtaah::integer END AS member_since,
               CASE WHEN a.dtlaah > 0 THEN date '1899-12-30' + a.dtlaah::integer END AS last_activity_date,
               CASE WHEN a.ltdtah >= 0 THEN a.ltdtah::integer END AS lifetime_trips,
               -a.ttwlah AS lifetime_casino_win,
               CASE WHEN a.ltdcah BETWEEN 0 AND 1000000000 THEN a.ltdcah END AS lifetime_comps,
               a.acelah AS action_cash_earned, a.acwlah AS action_cash_used,
               a.lvptah AS tier_points,
               CASE WHEN a.lvdtah > 0 THEN date '1899-12-30' + a.lvdtah::integer END AS tier_expires
        FROM dexiga_main.loyalty_acsc_cfpah_ws a
        JOIN cdp.site s ON s.corporate_id = trim(a.cpidah) AND s.property_id = trim(a.pridah)
        ORDER BY a.acctah, a.dtlaah DESC NULLS LAST
    ),
    -- All-play rows; the latest year per bucket for the "year" figures.
    bucket AS (
        SELECT DISTINCT ON (b.account_number, trim(b.bucket_id), trim(b.summary_level_code))
               b.account_number, trim(b.bucket_id) AS bucket, trim(b.summary_level_code) AS lvl,
               trim(b.summary_level_value) AS val, b.points_earned, b.total_earned_amount, b.total_redemption_amount,
               b.total_adjusted_amount, b.total_purged_amount
        FROM dexiga.customer_bucket_level_summary b
        JOIN cdp.site s ON s.corporate_id = trim(b.corporate_id) AND s.property_id = trim(b.property_id)
        WHERE coalesce(trim(b.play_type), '') = '' AND trim(b.summary_level_code) IN ('L', 'Y')
        ORDER BY b.account_number, trim(b.bucket_id), trim(b.summary_level_code), trim(b.summary_level_value) DESC
    ),
    buckets AS (
        SELECT account_number,
               max(points_earned) FILTER (WHERE bucket = 'PTTRACK' AND lvl = 'L') AS points_lifetime,
               max(points_earned) FILTER (WHERE bucket = 'PTTRACK' AND lvl = 'Y') AS points_year,
               max(val) FILTER (WHERE bucket = 'PTTRACK' AND lvl = 'Y') AS points_year_label,
               max(total_earned_amount) FILTER (WHERE bucket = 'REWARDS' AND lvl = 'L') AS rewards_earned_lifetime,
               max(total_redemption_amount) FILTER (WHERE bucket = 'REWARDS' AND lvl = 'L') AS rewards_redeemed_lifetime,
               max(total_adjusted_amount) FILTER (WHERE bucket = 'REWARDS' AND lvl = 'L') AS rewards_adjusted_lifetime,
               max(abs(total_purged_amount)) FILTER (WHERE bucket = 'REWARDS' AND lvl = 'L') AS rewards_expired_lifetime,
               max(total_earned_amount) FILTER (WHERE bucket = 'REWARDS' AND lvl = 'Y') AS rewards_earned_year,
               max(total_redemption_amount) FILTER (WHERE bucket = 'REWARDS' AND lvl = 'Y') AS rewards_redeemed_year
        FROM bucket GROUP BY 1
    )
    SELECT coalesce(l.account_number, b.account_number),
           l.member_since, l.last_activity_date, l.lifetime_trips, l.lifetime_casino_win, l.lifetime_comps,
           l.action_cash_earned, l.action_cash_used, l.tier_points, l.tier_expires,
           b.points_lifetime, b.points_year, b.points_year_label,
           b.rewards_earned_lifetime, b.rewards_redeemed_lifetime, b.rewards_adjusted_lifetime, b.rewards_expired_lifetime,
           b.rewards_earned_year, b.rewards_redeemed_year
    FROM lifetime l
    FULL JOIN buckets b USING (account_number);

    -- Gaming. Feed: winstar_gaming. CFPPAS columns, decoded by position against GEM's own
    -- readable layouts (dexiga.customer_gaming_activity_summary, dexiga_analytical.gaming_activity_slots_summary):
    -- svalpas trip day (days since 1899-12-30), tstrpas start HHMMSS, sgrppas S slots / G, GP tables /
    -- A all play, tytppas rating type, dsplpas days played, ptimpas minutes, nratpas ratings,
    -- avgbpas average bet, accipas / accopas coin in / out, ttwnpas theo, wnlspas win/loss (player side),
    -- rtptpas points, cmfdpas / cmbvpas / cmrmpas / cmotpas / cmtrpas comps, cmptpas total comps,
    -- crn#pas room nights comped. Site comes from corporate + property ID. Rating type FUT rows
    -- carry no play and dates after the load (planned trips, it seems), so they are left out.
    INSERT INTO cdp.gaming_activity
    SELECT 'winstar:' || t.acctpas || ':' || t.svalpas || ':' || trim(t.sgrppas) || ':' || coalesce(t.source_rrn, 0),
           t.acctpas, s.site_code, date '1899-12-30' + t.svalpas,
           CASE WHEN t.tstrpas BETWEEN 1 AND 235959 AND t.tstrpas / 100 % 100 < 60 AND t.tstrpas % 100 < 60
                THEN make_time(t.tstrpas / 10000, t.tstrpas / 100 % 100, t.tstrpas % 100) END,
           CASE trim(t.sgrppas) WHEN 'S' THEN 'slot' WHEN 'G' THEN 'table' WHEN 'GP' THEN 'table' ELSE 'mixed' END,
           nullif(trim(t.tytppas), ''),
           coalesce(t.dsplpas, 0), coalesce(t.ptimpas, 0), coalesce(t.nratpas, 0),
           coalesce(t.avgbpas, 0)::numeric, coalesce(t.accipas, 0), coalesce(t.accopas, 0),
           coalesce(t.ttwnpas, 0)::numeric, -coalesce(t.wnlspas, 0), coalesce(t.rtptpas, 0),
           coalesce(t.cmfdpas, 0), coalesce(t.cmbvpas, 0), coalesce(t.cmrmpas, 0),
           coalesce(t.cmotpas, 0) + coalesce(t.cmtrpas, 0), coalesce(t.cmptpas, 0)::numeric, coalesce(t."crn#pas", 0),
           'winstar_gaming', false
    FROM dexiga.customer_gaming_activity_summary_trip_ws t
    JOIN cdp.site s ON s.corporate_id = trim(t.cpidpas) AND s.property_id = trim(t.pridpas::text)
    WHERE trim(t.slvlpas) = 'T' AND t.svalpas > 0 AND trim(t.tytppas) IS DISTINCT FROM 'FUT';

    -- Gaming. Feed: mock_gaming (already in the readable layout).
    INSERT INTO cdp.gaming_activity
    SELECT 'mock:' || g.mock_visit_id || ':' || g.summary_grouping,
           g.account_number, s.site_code, date '1899-12-30' + g.summary_value::integer,
           make_time(div(g.property_time, 10000)::integer, (div(g.property_time, 100) % 100)::integer, 0),
           CASE g.summary_grouping WHEN 'S' THEN 'slot' ELSE 'table' END,
           g.rating_transaction_type, g.days_played, g.time_played_minutes, g.number_of_ratings,
           g.average_bet, g.coin_in, g.coin_out, g.theoretical_loss, -g.actual_win_loss, g.rating_points,
           g.comp_value_issued_food, g.comp_value_issued_beverage, g.comp_value_issued_room,
           g.comp_value_issued_others + g.comp_value_issued_transport, g.comp_value_issued_total, g.number_of_room_nights_comped,
           'mock_gaming', true
    FROM cdp_mock.gaming_trip_summary g
    JOIN cdp.site s ON s.corporate_id = g.corporate_id AND s.property_id = g.property_id;

    -- Identity. Feeds: mock_contacts, mock_app.
    INSERT INTO cdp.identity_link
    SELECT CASE c.channel WHEN 'email' THEN 'email' ELSE 'mobile' END,
           CASE c.channel WHEN 'email' THEN lower(trim(c.value)) ELSE trim(c.value) END,
           c.account_number, c.verified_at IS NOT NULL, c.verified_at, 'mock_contacts'
    FROM cdp_mock.contact_point c
    ON CONFLICT DO NOTHING;

    INSERT INTO cdp.identity_link
    SELECT 'app_user', a.user_id::text, a.account_number, true, a.linked_at, 'mock_app'
    FROM cdp_mock.app_user a
    WHERE a.account_number IS NOT NULL;

    -- Non-gaming. Feeds: mock_hotel, mock_pos, mock_spa, mock_golf. Records without a
    -- Club Passport number are matched by email only when the email belongs to one player.
    INSERT INTO cdp.non_gaming_activity
    WITH unique_email AS (
        SELECT identifier_value AS email, min(account_number) AS account_number
        FROM cdp.identity_link WHERE identifier_type = 'email'
        GROUP BY 1 HAVING count(DISTINCT account_number) = 1
    )
    SELECT 'stay:' || h.stay_id, 'hotel', h.site_code, h.source_system,
           coalesce(h.account_number, e.account_number),
           CASE WHEN h.account_number IS NOT NULL THEN 'card' WHEN e.account_number IS NOT NULL THEN 'email' END,
           h.arrival_date, (h.arrival_date + time '15:00') AT TIME ZONE s.time_zone,
           CASE h.status WHEN 'Checked Out' THEN 'completed' WHEN 'Cancelled' THEN 'cancelled' ELSE 'no_show' END,
           h.room_revenue, h.comp_room_revenue, 0, h.room_revenue - h.comp_room_revenue,
           h.nights, NULL, h.room_type || ' / ' || h.market_segment, 'stay:' || h.stay_id,
           'mock_hotel', true
    FROM cdp_mock.hotel_stay h
    JOIN cdp.site s USING (site_code)
    LEFT JOIN unique_email e ON h.account_number IS NULL AND e.email = lower(trim(h.guest_email));

    INSERT INTO cdp.non_gaming_activity
    SELECT 'check:' || c.check_id, CASE WHEN c.outlet_type = 'retail' THEN 'retail' ELSE 'dining' END,
           c.site_code, c.source_system, c.account_number, CASE WHEN c.account_number IS NOT NULL THEN 'card' END,
           (c.opened_at AT TIME ZONE s.time_zone)::date, c.opened_at, 'completed',
           c.food_amount + c.beverage_amount + c.merchandise_amount,
           c.comp_amount,
           CASE c.payment_type WHEN 'Points' THEN c.food_amount + c.beverage_amount + c.merchandise_amount ELSE 0 END,
           CASE WHEN c.payment_type IN ('Comp', 'Points') THEN 0 ELSE c.food_amount + c.beverage_amount + c.merchandise_amount END,
           NULL, c.covers, o.outlet_name, CASE WHEN c.stay_id IS NOT NULL THEN 'stay:' || c.stay_id END,
           'mock_pos', true
    FROM cdp_mock.pos_check c
    JOIN cdp.site s USING (site_code)
    JOIN cdp_mock.outlet o USING (outlet_id);

    INSERT INTO cdp.non_gaming_activity
    SELECT 'spa:' || a.appointment_id, 'spa', a.site_code, a.source_system, a.account_number, 'card',
           (a.appointment_at AT TIME ZONE s.time_zone)::date, a.appointment_at,
           CASE a.status WHEN 'Completed' THEN 'completed' WHEN 'Cancelled' THEN 'cancelled' ELSE 'no_show' END,
           CASE WHEN a.status = 'Completed' THEN a.price ELSE 0 END, a.comp_amount, 0,
           CASE WHEN a.status = 'Completed' THEN a.price - a.comp_amount ELSE 0 END,
           NULL, NULL, a.service_name, CASE WHEN a.stay_id IS NOT NULL THEN 'stay:' || a.stay_id END,
           'mock_spa', true
    FROM cdp_mock.spa_appointment a
    JOIN cdp.site s USING (site_code);

    INSERT INTO cdp.non_gaming_activity
    SELECT 'golf:' || r.round_id, 'golf', r.site_code, r.source_system, r.account_number, 'card',
           (r.tee_time AT TIME ZONE s.time_zone)::date, r.tee_time,
           CASE r.status WHEN 'Completed' THEN 'completed' WHEN 'Cancelled' THEN 'cancelled' ELSE 'no_show' END,
           CASE WHEN r.status = 'Completed' THEN r.green_fee + r.cart_fee ELSE 0 END, r.comp_amount, 0,
           CASE WHEN r.status = 'Completed' THEN r.green_fee + r.cart_fee - r.comp_amount ELSE 0 END,
           NULL, r.players_in_group, r.holes || ' holes', NULL,
           'mock_golf', true
    FROM cdp_mock.golf_round r
    JOIN cdp.site s USING (site_code);

    -- The 12-month window ends on the latest day with play (the loyalty data's "as of"), unless
    -- cdp.setting says otherwise. Non-gaming after that day (the tail of multi-night visits)
    -- is kept but falls outside the window.
    SELECT coalesce((SELECT nullif(value, '')::date FROM cdp.setting WHERE key = 'as_of_date'),
                    (SELECT max(activity_date) FROM cdp.gaming_activity WHERE days_played > 0 OR theo > 0))
    INTO v_as_of;
    v_from := v_as_of - 364;

    -- Preferences. Feeds: winstar_ratings, mock_gaming (slot ratings); trips from cdp.gaming_activity.
    -- Ties go to the larger coin-in or theo, then the lower code, so reruns agree.
    INSERT INTO cdp.player_preference
    WITH rating AS (
        SELECT r.account_number, trim(r.game_id) AS game_id, r.slot_denomination AS denomination, r.coin_in_dollars_cents AS coin_in
        FROM dexiga.customer_slot_rating r
        JOIN cdp.site s ON s.corporate_id = trim(r.corporate_id) AND s.property_id = trim(r.property_id)
        WHERE date '1899-12-30' + r.transaction_date_hun_year::integer BETWEEN v_from AND v_as_of
        UNION ALL
        SELECT account_number, trim(game_id), slot_denomination, coin_in_dollars_cents
        FROM cdp_mock.slot_rating
        WHERE date '1899-12-30' + transaction_date_hun_year::integer BETWEEN v_from AND v_as_of
    ),
    game AS (
        SELECT DISTINCT ON (account_number) account_number, game_id, coin_in / nullif(total, 0) AS share
        FROM (SELECT account_number, game_id, sum(coin_in) AS coin_in, sum(sum(coin_in)) OVER (PARTITION BY account_number) AS total
              FROM rating WHERE game_id <> '' GROUP BY 1, 2) g
        ORDER BY account_number, coin_in DESC, game_id
    ),
    denomination AS (
        SELECT DISTINCT ON (account_number) account_number, denomination, coin_in / nullif(total, 0) AS share
        FROM (SELECT account_number, denomination, sum(coin_in) AS coin_in, sum(sum(coin_in)) OVER (PARTITION BY account_number) AS total
              FROM rating WHERE denomination > 0 GROUP BY 1, 2) d
        ORDER BY account_number, coin_in DESC, denomination
    ),
    rated AS (SELECT account_number, count(*) AS n FROM rating GROUP BY 1),
    trip AS (
        SELECT account_number, activity_date, min(trip_start) AS trip_start, sum(theo) AS theo
        FROM cdp.gaming_activity
        WHERE activity_date BETWEEN v_from AND v_as_of AND (days_played > 0 OR theo > 0)
        GROUP BY account_number, site_code, activity_date
    ),
    weekday AS (
        SELECT DISTINCT ON (account_number) account_number, dow, trips::numeric / total AS share
        FROM (SELECT account_number, extract(isodow FROM activity_date)::integer AS dow, count(*) AS trips, sum(theo) AS theo,
                     sum(count(*)) OVER (PARTITION BY account_number) AS total
              FROM trip GROUP BY 1, 2) w
        ORDER BY account_number, trips DESC, theo DESC, dow
    ),
    daypart AS (
        SELECT DISTINCT ON (account_number) account_number, part, trips::numeric / total AS share
        FROM (SELECT account_number,
                     CASE WHEN trip_start >= '06:00' AND trip_start < '12:00' THEN 'morning'
                          WHEN trip_start >= '12:00' AND trip_start < '17:00' THEN 'afternoon'
                          WHEN trip_start >= '17:00' AND trip_start < '22:00' THEN 'evening'
                          ELSE 'late night' END AS part,
                     count(*) AS trips, sum(count(*)) OVER (PARTITION BY account_number) AS total
              FROM trip WHERE trip_start IS NOT NULL GROUP BY 1, 2) p
        ORDER BY account_number, trips DESC, part
    ),
    players AS (SELECT account_number FROM rated UNION SELECT account_number FROM weekday)
    SELECT x.account_number, g.game_id, round(g.share, 4), d.denomination, round(d.share, 4), coalesce(r.n, 0),
           w.dow, round(w.share, 4), p.part, round(p.share, 4)
    FROM players x
    LEFT JOIN game g USING (account_number)
    LEFT JOIN denomination d USING (account_number)
    LEFT JOIN rated r USING (account_number)
    LEFT JOIN weekday w USING (account_number)
    LEFT JOIN daypart p USING (account_number);

    -- Per player and site. A gaming trip is a (player, site, day) with play; its days are the
    -- longest days_played among its game types, so slots + tables on one trip count once.
    INSERT INTO cdp.player_site_summary
    WITH trip AS (
        SELECT account_number, site_code, activity_date,
               max(days_played) AS days, sum(theo) AS theo, sum(casino_win) AS casino_win, sum(comp_total) AS comps
        FROM cdp.gaming_activity
        WHERE activity_date BETWEEN v_from AND v_as_of AND (days_played > 0 OR theo > 0)
        GROUP BY 1, 2, 3
    ),
    ng AS (
        SELECT account_number, site_code, activity_date, paid_amount, comp_amount + points_amount AS comp
        FROM cdp.non_gaming_activity
        WHERE activity_date BETWEEN v_from AND v_as_of AND status = 'completed' AND account_number IS NOT NULL
    ),
    days AS (
        SELECT account_number, site_code, activity_date FROM trip
        UNION
        SELECT account_number, site_code, activity_date FROM ng
    )
    SELECT d.account_number, d.site_code,
           count(*) AS visit_days,
           coalesce(t.trips, 0), coalesce(t.gaming_days, 0), coalesce(t.theo, 0), coalesce(t.casino_win, 0), coalesce(t.comps, 0),
           coalesce(n.paid, 0), coalesce(n.comp, 0),
           min(d.activity_date), max(d.activity_date)
    FROM days d
    LEFT JOIN (SELECT account_number, site_code, count(*) AS trips, sum(days) AS gaming_days, sum(theo) AS theo,
                      sum(casino_win) AS casino_win, sum(comps) AS comps
               FROM trip GROUP BY 1, 2) t USING (account_number, site_code)
    LEFT JOIN (SELECT account_number, site_code, sum(paid_amount) AS paid, sum(comp) AS comp
               FROM ng GROUP BY 1, 2) n USING (account_number, site_code)
    GROUP BY d.account_number, d.site_code, t.trips, t.gaming_days, t.theo, t.casino_win, t.comps, n.paid, n.comp;

    -- Reachability. Feeds: winstar_patrons (exclusions, mailing address), mock_contacts,
    -- mock_consent, mock_app (push needs a linked app account).
    INSERT INTO cdp.reachability
    WITH base AS (
        SELECT trim(m.account_number)::numeric AS account_number,
               nullif(trim(m.residential_zip), '') IS NOT NULL AS has_address,
               EXISTS (SELECT 1 FROM dexiga.exclusion_history x WHERE x.account_number = trim(m.account_number)::numeric) AS is_excluded
        FROM dexiga.customer_master m
        WHERE trim(m.account_number) ~ '^\d+$'
    ),
    per_channel AS (
        SELECT b.account_number, b.is_excluded, ch.channel,
               CASE ch.channel
                   WHEN 'email' THEN EXISTS (SELECT 1 FROM cdp.identity_link i WHERE i.account_number = b.account_number AND i.identifier_type = 'email')
                   WHEN 'sms'   THEN EXISTS (SELECT 1 FROM cdp.identity_link i WHERE i.account_number = b.account_number AND i.identifier_type = 'mobile')
                   WHEN 'push'  THEN EXISTS (SELECT 1 FROM cdp.identity_link i WHERE i.account_number = b.account_number AND i.identifier_type = 'app_user')
                   ELSE b.has_address END AS has_contact,
               c.status, c.captured_at
        FROM base b
        CROSS JOIN (VALUES ('email'), ('sms'), ('push'), ('mail')) ch(channel)
        LEFT JOIN cdp_mock.v_consent_current c
               ON c.account_number = b.account_number AND c.channel = ch.channel AND c.purpose = 'marketing'
    )
    SELECT account_number, channel, has_contact, coalesce(status, 'none'), captured_at,
           NOT is_excluded AND has_contact AND status = 'opt_in' IS TRUE,
           CASE WHEN is_excluded THEN 'self_excluded'
                WHEN NOT has_contact THEN 'no_contact'
                WHEN status = 'opt_out' THEN 'opted_out'
                WHEN status IS NULL THEN 'no_consent'
                ELSE 'reachable' END
    FROM per_channel;

    -- Profile. Feeds: winstar_patrons (base, state, sign-up, real tiers, exclusions),
    -- mock_tiers (tiers the sample lacks), mock_app (app use).
    INSERT INTO cdp.player_profile
    WITH base AS (
        SELECT trim(m.account_number)::numeric AS account_number,
               nullif(upper(trim(m.residential_state)), '') AS residential_state,
               CASE upper(trim(m.residential_state)) WHEN 'TX' THEN 'TX' WHEN 'OK' THEN 'OK' ELSE 'OTHER' END AS home_region,
               CASE WHEN m.date_created ~ '^\d{4}-\d\d-\d\d$' THEN m.date_created::date END AS real_signup
        FROM dexiga.customer_master m
        WHERE trim(m.account_number) ~ '^\d+$'
    ),
    tier AS (
        SELECT p.account_number, t.tier_name, t.tier_rank, p.tier_source, p.signup_date, p.is_excluded
        FROM cdp_mock.player p JOIN cdp_mock.tier t USING (card_level)
    ),
    sites AS (
        SELECT account_number,
               count(*) AS sites_visited,
               array_agg(site_code ORDER BY site_code) AS site_codes,
               (array_agg(site_code ORDER BY visit_days DESC, theo DESC, site_code))[1] AS home_site,
               sum(visit_days) AS visit_days, sum(trips) AS trips, sum(gaming_days) AS gaming_days,
               sum(theo) AS theo, sum(casino_win) AS casino_win, sum(comps_issued) AS comps, sum(non_gaming_comp) AS ng_comp
        FROM cdp.player_site_summary GROUP BY 1
    ),
    slot AS (
        SELECT account_number, sum(theo) FILTER (WHERE game_type = 'slot') AS slot_theo
        FROM cdp.gaming_activity WHERE activity_date BETWEEN v_from AND v_as_of GROUP BY 1
    ),
    ever AS (
        SELECT account_number, min(d) AS first_date, max(d) AS last_date, max(g) AS last_gaming
        FROM (SELECT account_number, activity_date AS d, activity_date AS g FROM cdp.gaming_activity
                WHERE activity_date <= v_as_of AND (days_played > 0 OR theo > 0)
              UNION ALL
              SELECT account_number, activity_date, NULL FROM cdp.non_gaming_activity
                WHERE activity_date <= v_as_of AND status = 'completed' AND account_number IS NOT NULL) x
        GROUP BY 1
    ),
    ng AS (
        SELECT account_number,
               count(*) FILTER (WHERE activity_type = 'hotel') AS stays,
               coalesce(sum(nights) FILTER (WHERE activity_type = 'hotel'), 0) AS nights,
               coalesce(sum(paid_amount) FILTER (WHERE activity_type = 'hotel'), 0) AS hotel,
               coalesce(sum(paid_amount) FILTER (WHERE activity_type = 'dining'), 0) AS dining,
               coalesce(sum(paid_amount) FILTER (WHERE activity_type = 'retail'), 0) AS retail,
               coalesce(sum(paid_amount) FILTER (WHERE activity_type = 'spa'), 0) AS spa,
               coalesce(sum(paid_amount) FILTER (WHERE activity_type = 'golf'), 0) AS golf,
               sum(paid_amount) AS paid
        FROM cdp.non_gaming_activity
        WHERE activity_date BETWEEN v_from AND v_as_of AND status = 'completed' AND account_number IS NOT NULL
        GROUP BY 1
    ),
    app AS (
        SELECT a.account_number, a.user_id, a.linked_at,
               (SELECT count(DISTINCT (e."createdDate" AT TIME ZONE 'America/Chicago')::date)
                FROM cdp_mock.app_event e
                WHERE e."userId" = a.user_id::text
                  AND (e."createdDate" AT TIME ZONE 'America/Chicago')::date BETWEEN v_as_of - 89 AND v_as_of) AS active_days,
               (SELECT max(e."createdDate") FROM cdp_mock.app_event e
                WHERE e."userId" = a.user_id::text AND (e."createdDate" AT TIME ZONE 'America/Chicago')::date <= v_as_of) AS last_active
        FROM cdp_mock.app_user a WHERE a.account_number IS NOT NULL
    ),
    reach AS (
        SELECT account_number, coalesce(array_agg(channel ORDER BY channel) FILTER (WHERE is_reachable), '{}') AS channels
        FROM cdp.reachability GROUP BY 1
    ),
    mock_used AS (
        SELECT DISTINCT account_number FROM cdp.gaming_activity WHERE is_mock
        UNION SELECT DISTINCT account_number FROM cdp.non_gaming_activity WHERE is_mock AND account_number IS NOT NULL
    ),
    assembled AS (
        SELECT b.account_number, v_as_of AS as_of_date,
               t.tier_name, t.tier_rank, t.tier_source, b.residential_state, b.home_region,
               coalesce(b.real_signup, t.signup_date) AS signup_date,
               v_as_of - coalesce(b.real_signup, t.signup_date) AS tenure_days,
               t.is_excluded,
               s.home_site, coalesce(s.sites_visited, 0) AS sites_visited, coalesce(s.site_codes, '{}') AS site_codes,
               e.first_date, e.last_date, e.last_gaming, v_as_of - e.last_date AS recency_days,
               coalesce(s.visit_days, 0) AS visit_days, coalesce(s.trips, 0) AS trips, coalesce(s.gaming_days, 0) AS gaming_days,
               coalesce(s.theo, 0) AS theo, coalesce(s.casino_win, 0) AS casino_win, sl.slot_theo,
               coalesce(s.comps, 0) AS comps,
               coalesce(n.stays, 0) AS stays, coalesce(n.nights, 0) AS nights, coalesce(n.hotel, 0) AS hotel,
               coalesce(n.dining, 0) AS dining, coalesce(n.retail, 0) AS retail, coalesce(n.spa, 0) AS spa, coalesce(n.golf, 0) AS golf,
               coalesce(n.paid, 0) AS ng_paid, coalesce(s.ng_comp, 0) AS ng_comp,
               a.user_id, a.linked_at, coalesce(a.active_days, 0) AS app_days, a.last_active,
               coalesce(r.channels, '{}') AS channels,
               mu.account_number IS NOT NULL AS has_mock
        FROM base b
        JOIN tier t USING (account_number)
        LEFT JOIN sites s USING (account_number)
        LEFT JOIN slot sl USING (account_number)
        LEFT JOIN ever e USING (account_number)
        LEFT JOIN ng n USING (account_number)
        LEFT JOIN app a USING (account_number)
        LEFT JOIN reach r USING (account_number)
        LEFT JOIN mock_used mu USING (account_number)
    ),
    -- RFM scores among players active in the window: percent rank in fifths, so ties share a score.
    rfm AS (
        SELECT account_number,
               least(5, 1 + floor(percent_rank() OVER (ORDER BY recency_days DESC) * 5))::integer AS r,
               least(5, 1 + floor(percent_rank() OVER (ORDER BY visit_days) * 5))::integer AS f,
               least(5, 1 + floor(percent_rank() OVER (ORDER BY theo + ng_paid) * 5))::integer AS m
        FROM assembled WHERE visit_days > 0
    )
    SELECT x.account_number, x.as_of_date, x.tier_name, x.tier_rank, x.tier_source, x.residential_state, x.home_region,
           x.signup_date, x.tenure_days, x.is_excluded, x.home_site, x.sites_visited, x.site_codes,
           x.first_date, x.last_date, x.last_gaming, x.recency_days,
           x.visit_days, x.trips, x.gaming_days, x.theo,
           round(x.theo / nullif(x.gaming_days, 0), 2), x.casino_win,
           round(x.slot_theo / nullif(x.theo, 0), 4), x.comps, round(x.comps / nullif(x.theo, 0), 4),
           x.stays, x.nights, x.hotel, x.dining, x.retail, x.spa, x.golf, x.ng_paid, x.ng_comp,
           round(x.ng_paid / nullif(x.ng_paid + x.theo, 0), 4), x.theo + x.ng_paid,
           f.r, f.f, f.m,
           x.user_id, x.linked_at, x.app_days, x.last_active,
           x.channels, cardinality(x.channels) > 0, x.has_mock,
           hs.rep_code, hs.host_name,
           lo.tier_points, cur.low_points, nxt.tier_name, nxt.low_points,
           CASE WHEN lo.tier_points IS NOT NULL AND nxt.low_points IS NOT NULL THEN greatest(nxt.low_points - lo.tier_points, 0) END,
           lo.tier_expires, lo.lifetime_trips, lo.lifetime_casino_win,
           pr.top_game, pr.top_denomination, pr.favorite_weekday, pr.favorite_daypart
    FROM assembled x
    LEFT JOIN rfm f USING (account_number)
    LEFT JOIN cdp.player_loyalty lo USING (account_number)
    LEFT JOIN cdp.player_preference pr USING (account_number)
    LEFT JOIN LATERAL (
        SELECT h.rep_code, h.host_name FROM cdp.player_host h
        WHERE h.account_number = x.account_number
        ORDER BY h.is_permanent DESC, h.site_code, h.rep_code LIMIT 1
    ) hs ON true
    LEFT JOIN cdp.tier_rule cur ON cur.tier_rank = x.tier_rank
    LEFT JOIN cdp.tier_rule nxt ON nxt.tier_rank = x.tier_rank + 1;

    -- Segments.
    FOR seg IN SELECT segment_code, rule FROM cdp.segment ORDER BY sort_order LOOP
        EXECUTE format('INSERT INTO cdp.segment_member SELECT %L, account_number FROM cdp.player_profile WHERE NOT is_excluded AND (%s)',
                       seg.segment_code, seg.rule);
    END LOOP;

    UPDATE cdp.refresh_run
    SET finished_at = clock_timestamp(), as_of_date = v_as_of,
        row_counts = jsonb_build_object(
            'gaming_activity',     (SELECT count(*) FROM cdp.gaming_activity),
            'non_gaming_activity', (SELECT count(*) FROM cdp.non_gaming_activity),
            'identity_link',       (SELECT count(*) FROM cdp.identity_link),
            'player_site_summary', (SELECT count(*) FROM cdp.player_site_summary),
            'player_host',         (SELECT count(*) FROM cdp.player_host),
            'player_loyalty',      (SELECT count(*) FROM cdp.player_loyalty),
            'player_preference',   (SELECT count(*) FROM cdp.player_preference),
            'player_profile',      (SELECT count(*) FROM cdp.player_profile),
            'reachability',        (SELECT count(*) FROM cdp.reachability),
            'segment_member',      (SELECT count(*) FROM cdp.segment_member))
    WHERE run_id = v_run_id;
END
$proc$;

-- One player at a glance: the profile plus segment names.
CREATE VIEW cdp.v_player_360 AS
SELECT p.*,
       coalesce((SELECT array_agg(m.segment_code ORDER BY s.sort_order)
                 FROM cdp.segment_member m JOIN cdp.segment s USING (segment_code)
                 WHERE m.account_number = p.account_number), '{}') AS segments
FROM cdp.player_profile p;

-- Segment sizes and how many members can be reached on each channel.
CREATE VIEW cdp.v_segment_summary AS
SELECT s.segment_code, s.name, s.sort_order,
       count(m.account_number) AS members,
       count(*) FILTER (WHERE 'email' = ANY (p.reachable_channels)) AS reachable_email,
       count(*) FILTER (WHERE 'sms' = ANY (p.reachable_channels)) AS reachable_sms,
       count(*) FILTER (WHERE 'push' = ANY (p.reachable_channels)) AS reachable_push,
       count(*) FILTER (WHERE 'mail' = ANY (p.reachable_channels)) AS reachable_mail,
       round(avg(p.theo_12m), 2) AS avg_theo_12m,
       round(avg(p.non_gaming_paid_12m), 2) AS avg_non_gaming_paid_12m
FROM cdp.segment s
LEFT JOIN cdp.segment_member m USING (segment_code)
LEFT JOIN cdp.player_profile p USING (account_number)
GROUP BY s.segment_code, s.name, s.sort_order;

COMMIT;
