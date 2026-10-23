-- MOCK DATA: non-gaming activity at every site, as it might arrive from Agilysys systems
-- through Chickasaw's data warehouse. Every row carries the Club Passport number when the
-- guest gave one; some rows deliberately have none, to exercise identity matching.
--
-- Built on cdp_mock.visit: hotel stays for overnight visits at hotel sites, dining and
-- retail checks during visits, spa services during hotel stays, golf rounds at WinStar.
-- System names per site are placeholders (see cdp_mock.site.hotel_system).

BEGIN;

-- Visit context reused by every section below.
CREATE TEMP TABLE visit_ctx ON COMMIT DROP AS
SELECT v.*, s.site_no, s.loyalty_property_id AS property_id, s.hotel_system, s.nightly_rate, s.has_spa, s.has_golf,
       t.tier_rank, v.nights + 1 AS days
FROM cdp_mock.visit v
JOIN cdp_mock.site s USING (site_code)
JOIN cdp_mock.player pl USING (account_number)
JOIN cdp_mock.tier t USING (card_level);

-- ---------------------------------------------------------------- hotel stays

CREATE TABLE cdp_mock.hotel_stay (
    stay_id             bigint PRIMARY KEY,
    source_system       text NOT NULL,
    site_code           text NOT NULL REFERENCES cdp_mock.site,
    property_id         text NOT NULL,
    confirmation_number text NOT NULL UNIQUE,
    account_number      numeric REFERENCES cdp_mock.player,   -- Club Passport number; NULL = none given
    guest_email         text,                                 -- only on stays without an account number
    arrival_date        date NOT NULL,
    departure_date      date NOT NULL,
    nights              integer NOT NULL,
    room_type           text NOT NULL,
    rate_code           text NOT NULL,
    market_segment      text NOT NULL,
    booking_channel     text NOT NULL,
    adults              integer NOT NULL,
    children            integer NOT NULL,
    room_revenue        numeric(12,2) NOT NULL,
    comp_room_revenue   numeric(12,2) NOT NULL,              -- matches comp_value_issued_room on mocked-site gaming trips
    room_tax            numeric(12,2) NOT NULL,
    status              text NOT NULL CHECK (status IN ('Checked Out', 'Cancelled', 'No Show')),
    booked_at           timestamptz NOT NULL,
    mock_visit_id       bigint REFERENCES cdp_mock.visit
);
COMMENT ON TABLE cdp_mock.hotel_stay IS
    'MOCK. Hotel stays (Agilysys LMS / Stay / Versa placeholders). Member stays come from overnight visits; extra rows are cancellations, no-shows and stays with no Club Passport number (half of those carry a known player''s email).';

-- Players by position, to pick "some other player" with one key.
CREATE TEMP TABLE player_rn ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY account_number)::integer AS rn, account_number FROM cdp_mock.player;
ALTER TABLE player_rn ADD PRIMARY KEY (rn);

CREATE TEMP TABLE stay_stage ON COMMIT DROP AS
SELECT v.*,
       cdp_mock.wpick('room:' || v.visit_id, '{King,Double Queen,Tower King,Suite}',
           CASE v.tier_rank WHEN 3 THEN '{30,15,30,25}'::float8[] WHEN 2 THEN '{40,30,20,10}'::float8[] ELSE '{45,45,8,2}'::float8[] END) AS room_type
FROM visit_ctx v
WHERE v.nights > 0 AND v.hotel_system IS NOT NULL;

INSERT INTO cdp_mock.hotel_stay
SELECT row_number() OVER (ORDER BY arrival_date, site_code, coalesce(account_number, 0), kind, src_id) AS stay_id,
       hotel_system, site_code, property_id,
       upper(left(site_code, 2)) || lpad((row_number() OVER (ORDER BY arrival_date, site_code, coalesce(account_number, 0), kind, src_id))::text, 8, '0'),
       account_number, guest_email, arrival_date, arrival_date + nights, nights, room_type, rate_code, market_segment, booking_channel,
       adults, children, room_revenue, comp_room_revenue, round(room_revenue * 0.13 * (comp_room_revenue = 0)::integer, 2),
       status, booked_at, mock_visit_id
FROM (
    -- Stays that happened.
    SELECT 1 AS kind, st.visit_id AS src_id, st.hotel_system, st.site_code, st.property_id, st.account_number,
           NULL::text AS guest_email, st.visit_date AS arrival_date, st.nights, st.room_type,
           CASE WHEN st.room_comped THEN 'COMP' ELSE cdp_mock.wpick('rate:' || st.visit_id, '{CASINO,BAR,PKG,AAA}', '{50,30,12,8}') END AS rate_code,
           CASE WHEN st.room_comped THEN 'Casino Comp' ELSE 'Casino Rate' END AS market_segment,
           CASE WHEN st.room_comped THEN cdp_mock.wpick('chan:' || st.visit_id, '{Host,Call Center}', '{60,40}')
                ELSE cdp_mock.wpick('chan:' || st.visit_id, '{Website,App,Call Center,OTA}', '{45,15,25,15}') END AS booking_channel,
           least(st.party_size, 4) AS adults,
           CASE WHEN cdp_mock.u('kids:' || st.visit_id) < 0.10 THEN 1 + (cdp_mock.u('kids2:' || st.visit_id) < 0.4)::integer ELSE 0 END AS children,
           CASE WHEN st.room_comped THEN round(st.nightly_rate * st.nights, 2)
                ELSE round((st.nightly_rate * st.nights
                            * CASE st.room_type WHEN 'Suite' THEN 2.2 WHEN 'Tower King' THEN 1.3 ELSE 1 END
                            * CASE WHEN extract(isodow FROM st.visit_date) IN (5, 6) THEN 1.35 ELSE 1 END
                            * exp(0.15 * cdp_mock.n('adr:' || st.visit_id)))::numeric, 2) END AS room_revenue,
           CASE WHEN st.room_comped THEN round(st.nightly_rate * st.nights, 2) ELSE 0 END AS comp_room_revenue,
           'Checked Out' AS status,
           cdp_mock.at_site(st.visit_date - ceil(cdp_mock.expo('lead:' || st.visit_id, 14))::integer,
                            cdp_mock.clock('booked:' || st.visit_id, 8, 14)) AS booked_at,
           st.visit_id AS mock_visit_id
    FROM stay_stage st

    UNION ALL
    -- Bookings by the same players that were cancelled (6%) or never arrived (2%).
    SELECT 2, st.visit_id, st.hotel_system, st.site_code, st.property_id, st.account_number, NULL,
           least(p.end_date, greatest(p.start_date, st.visit_date + (cdp_mock.u('cxday:' || st.visit_id) * 60)::integer - 30)),
           st.nights, st.room_type, 'BAR', 'Casino Rate', cdp_mock.wpick('cxchan:' || st.visit_id, '{Website,App,Call Center,OTA}', '{45,15,25,15}'),
           least(st.party_size, 4), 0,
           CASE WHEN cdp_mock.u('cx:' || st.visit_id) < 0.06 THEN 0 ELSE st.nightly_rate END, 0,
           CASE WHEN cdp_mock.u('cx:' || st.visit_id) < 0.06 THEN 'Cancelled' ELSE 'No Show' END,
           cdp_mock.at_site(st.visit_date - 45, cdp_mock.clock('cxbooked:' || st.visit_id, 8, 14)),
           NULL
    FROM stay_stage st CROSS JOIN cdp_mock.params p
    WHERE cdp_mock.u('cx:' || st.visit_id) < 0.08

    UNION ALL
    -- Guests who gave no Club Passport number (for every fifth member stay). Half of them
    -- book with the email of a known player, so the CDP can match them; the rest are strangers.
    SELECT 3, st.visit_id, st.hotel_system, st.site_code, st.property_id, NULL,
           CASE WHEN cdp_mock.u('anonmatch:' || st.visit_id) < 0.5 THEN cdp_mock.player_email(other.account_number) END
               ::text,
           least(p.end_date, greatest(p.start_date, st.visit_date + (cdp_mock.u('anonday:' || st.visit_id) * 60)::integer - 30)),
           st.nights, st.room_type, cdp_mock.wpick('anonrate:' || st.visit_id, '{BAR,OTA,AAA,GRP}', '{45,30,15,10}'),
           'Transient', cdp_mock.wpick('anonchan:' || st.visit_id, '{Website,OTA,Call Center}', '{45,40,15}'),
           least(st.party_size, 4), 0,
           round((st.nightly_rate * st.nights * exp(0.15 * cdp_mock.n('anonadr:' || st.visit_id)))::numeric, 2), 0,
           'Checked Out',
           cdp_mock.at_site(st.visit_date - 21, cdp_mock.clock('anonbooked:' || st.visit_id, 8, 14)),
           NULL
    FROM stay_stage st
    CROSS JOIN cdp_mock.params p
    JOIN player_rn other ON other.rn = 1 + floor(cdp_mock.u('anonwho:' || st.visit_id) * (SELECT count(*) FROM player_rn))::integer
    WHERE cdp_mock.u('anon:' || st.visit_id) < 0.20
) s;

-- Strangers get an address of their own.
UPDATE cdp_mock.hotel_stay
SET guest_email = 'guest' || stay_id || '@example.com'
WHERE account_number IS NULL AND guest_email IS NULL;

CREATE INDEX ON cdp_mock.hotel_stay (account_number);
CREATE INDEX ON cdp_mock.hotel_stay (guest_email) WHERE guest_email IS NOT NULL;
CREATE INDEX ON cdp_mock.hotel_stay (mock_visit_id);

-- ---------------------------------------------------------------- dining and retail

CREATE TABLE cdp_mock.outlet (
    outlet_id       integer PRIMARY KEY,
    site_code       text NOT NULL REFERENCES cdp_mock.site,
    outlet_name     text NOT NULL,
    outlet_type     text NOT NULL CHECK (outlet_type IN ('fine_dining', 'casual', 'buffet', 'bar', 'quick_service', 'retail')),
    source_system   text NOT NULL,
    avg_per_cover   numeric(8,2) NOT NULL,   -- retail: average basket
    popularity      double precision NOT NULL
);
COMMENT ON TABLE cdp_mock.outlet IS 'MOCK. Generic outlet names, not the sites'' real restaurants and shops.';

INSERT INTO cdp_mock.outlet VALUES
    ( 1, 'WINSTAR',   'Steakhouse',           'fine_dining',   'Agilysys POS',  95, 10),
    ( 2, 'WINSTAR',   'Buffet',               'buffet',        'Agilysys POS',  32, 25),
    ( 3, 'WINSTAR',   'Asian Kitchen',        'casual',        'Agilysys POS',  38, 15),
    ( 4, 'WINSTAR',   'Sports Bar',           'bar',           'Agilysys POS',  28, 20),
    ( 5, 'WINSTAR',   'Coffee Shop',          'quick_service', 'Agilysys POS',  12, 20),
    ( 6, 'WINSTAR',   'Food Court',           'quick_service', 'Agilysys POS',  15, 25),
    ( 7, 'WINSTAR',   'Pool Bar',             'bar',           'Agilysys POS',  25,  5),
    ( 8, 'WINSTAR',   'Gift Shop',            'retail',        'Agilysys POS',  45, 60),
    ( 9, 'WINSTAR',   'Logo Shop',            'retail',        'Agilysys POS',  60, 40),
    (10, 'RIVERWIND', 'Steakhouse',           'fine_dining',   'Agilysys POS',  80, 10),
    (11, 'RIVERWIND', 'Buffet',               'buffet',        'Agilysys POS',  28, 25),
    (12, 'RIVERWIND', 'Grill',                'casual',        'Agilysys POS',  30, 20),
    (13, 'RIVERWIND', 'Lounge',               'bar',           'Agilysys POS',  22, 20),
    (14, 'RIVERWIND', 'Food Court',           'quick_service', 'Agilysys POS',  14, 25),
    (15, 'RIVERWIND', 'Gift Shop',            'retail',        'Agilysys POS',  35, 100),
    (16, 'REMINGTON', 'Clubhouse Restaurant', 'casual',        'Agilysys POS',  35, 30),
    (17, 'REMINGTON', 'Sports Bar',           'bar',           'Agilysys POS',  24, 35),
    (18, 'REMINGTON', 'Concessions',          'quick_service', 'Agilysys POS',  12, 35),
    (19, 'ARTESIAN',  'Hotel Restaurant',     'fine_dining',   'Agilysys POS',  70, 35),
    (20, 'ARTESIAN',  'Cafe',                 'quick_service', 'Agilysys POS',  14, 35),
    (21, 'ARTESIAN',  'Bar',                  'bar',           'Agilysys POS',  22, 30),
    (22, 'ARTESIAN',  'Spa Boutique',         'retail',        'Agilysys Spa',  55, 50),
    (23, 'ARTESIAN',  'Gift Shop',            'retail',        'Agilysys POS',  30, 50),
    (24, 'GOLDMTN',   'Grill',                'casual',        'Agilysys POS',  22, 60),
    (25, 'GOLDMTN',   'Snack Bar',            'quick_service', 'Agilysys POS',  10, 40),
    (26, 'NEWCASTLE', 'Buffet',               'buffet',        'Agilysys POS',  22, 40),
    (27, 'NEWCASTLE', 'Grill',                'casual',        'Agilysys POS',  22, 35),
    (28, 'NEWCASTLE', 'Snack Bar',            'quick_service', 'Agilysys POS',  10, 25),
    (29, 'TREASURE',  'Grill',                'casual',        'Agilysys POS',  22, 60),
    (30, 'TREASURE',  'Snack Bar',            'quick_service', 'Agilysys POS',  10, 40),
    (31, 'CHISHOLM',  'Grill',                'casual',        'Agilysys POS',  22, 60),
    (32, 'CHISHOLM',  'Snack Bar',            'quick_service', 'Agilysys POS',  10, 40);

CREATE TABLE cdp_mock.pos_check (
    check_id           bigint PRIMARY KEY,
    source_system      text NOT NULL,
    site_code          text NOT NULL REFERENCES cdp_mock.site,
    property_id        text NOT NULL,
    outlet_id          integer NOT NULL REFERENCES cdp_mock.outlet,
    outlet_type        text NOT NULL,
    account_number     numeric REFERENCES cdp_mock.player,  -- NULL = no card presented
    opened_at          timestamptz NOT NULL,
    closed_at          timestamptz NOT NULL,
    covers             integer NOT NULL,
    food_amount        numeric(10,2) NOT NULL,
    beverage_amount    numeric(10,2) NOT NULL,
    merchandise_amount numeric(10,2) NOT NULL,
    tax_amount         numeric(10,2) NOT NULL,
    tip_amount         numeric(10,2) NOT NULL,
    total_amount       numeric(10,2) NOT NULL,
    payment_type       text NOT NULL CHECK (payment_type IN ('Card', 'Cash', 'Comp', 'Points', 'Room Charge')),
    comp_amount        numeric(10,2) NOT NULL,
    stay_id            bigint REFERENCES cdp_mock.hotel_stay,
    mock_visit_id      bigint REFERENCES cdp_mock.visit
);
COMMENT ON TABLE cdp_mock.pos_check IS
    'MOCK. Dining and retail checks. Carded checks come from visits; about one uncarded check (account_number NULL) for every three carded ones.';

CREATE TEMP TABLE check_stage ON COMMIT DROP AS
WITH wanted AS (
    -- Dining: about one check per day trip, 1.5 more per night; higher tiers eat out more.
    -- Retail: 7% of day trips, 20% of overnight visits.
    SELECT v.*, 'dining' AS kind,
           round(cdp_mock.expo('ndine:' || v.visit_id, (1.0 + 1.5 * v.nights) * (1 + 0.2 * (v.tier_rank - 1))))::integer AS n
    FROM visit_ctx v
    UNION ALL
    SELECT v.*, 'retail', (cdp_mock.u('nretail:' || v.visit_id) < CASE WHEN v.nights > 0 THEN 0.20 ELSE 0.07 END)::integer
    FROM visit_ctx v
),
each_check AS (
    SELECT w.*, j, w.visit_id || ':' || w.kind || ':' || j AS k
    FROM wanted w CROSS JOIN LATERAL generate_series(1, w.n) j
),
with_outlet AS (
    SELECT c.*, o.outlet_id, o.outlet_type, o.source_system, o.avg_per_cover
    FROM each_check c
    CROSS JOIN LATERAL (
        SELECT o.* FROM (
            SELECT o.*, sum(o.popularity) OVER (ORDER BY o.outlet_id) AS upto, sum(o.popularity) OVER () AS total
            FROM cdp_mock.outlet o
            WHERE o.site_code = c.site_code AND (o.outlet_type = 'retail') = (c.kind = 'retail')
        ) o
        WHERE o.upto > cdp_mock.u('outlet:' || c.k) * o.total
        ORDER BY o.upto LIMIT 1
    ) o
)
SELECT c.*,
       c.visit_date + floor(cdp_mock.u('cday:' || c.k) * c.days)::integer AS check_date,
       CASE c.outlet_type WHEN 'bar' THEN cdp_mock.clock('ctime:' || c.k, 16, 9)
                          WHEN 'quick_service' THEN cdp_mock.clock('ctime:' || c.k, 7, 15)
                          WHEN 'retail' THEN cdp_mock.clock('ctime:' || c.k, 10, 11)
                          ELSE cdp_mock.clock('ctime:' || c.k, 11, 11) END AS check_time,
       CASE WHEN c.kind = 'retail' THEN 1
            ELSE least(8, c.party_size + (cdp_mock.u('xcover:' || c.k) < 0.2)::integer) END AS covers
FROM with_outlet c;

INSERT INTO cdp_mock.pos_check
SELECT row_number() OVER (ORDER BY opened_at, outlet_id, kk),
       source_system, site_code, property_id, outlet_id, outlet_type, account_number, opened_at,
       opened_at + make_interval(mins => CASE outlet_type WHEN 'retail' THEN 10 WHEN 'quick_service' THEN 15 WHEN 'fine_dining' THEN 95 ELSE 50 END),
       covers, food, beverage, merchandise, tax,
       tip, food + beverage + merchandise + tax + tip, payment_type,
       CASE payment_type WHEN 'Comp' THEN food + beverage + merchandise ELSE 0 END,
       stay_id, mock_visit_id
FROM (
    SELECT x.*,
           round(x.sub * 0.085, 2) AS tax,
           CASE WHEN x.payment_type IN ('Card', 'Cash', 'Room Charge') AND x.outlet_type IN ('fine_dining', 'casual', 'bar')
                THEN round(x.sub * 0.18, 2) ELSE 0 END AS tip
    FROM (
        SELECT c.*, c.food + c.beverage + c.merchandise AS sub
        FROM (
            SELECT cs.kk, cs.source_system, cs.site_code, cs.property_id, cs.outlet_id, cs.outlet_type,
                   CASE WHEN cs.carded THEN cs.account_number END AS account_number,
                   cdp_mock.at_site(cs.check_date, CASE WHEN cs.carded THEN cs.check_time
                                                        ELSE cdp_mock.clock('ctime:' || cs.kk, 11, 11) END) AS opened_at,
                   cs.covers,
                   CASE WHEN cs.outlet_type = 'retail' THEN 0
                        ELSE round((cs.covers * cs.avg_per_cover * CASE cs.outlet_type WHEN 'bar' THEN 0.3 ELSE 0.75 END
                                    * exp(0.35 * cdp_mock.n('amt:' || cs.kk)))::numeric, 2) END AS food,
                   CASE WHEN cs.outlet_type = 'retail' THEN 0
                        ELSE round((cs.covers * cs.avg_per_cover * CASE cs.outlet_type WHEN 'bar' THEN 0.7 ELSE 0.25 END
                                    * exp(0.5 * cdp_mock.n('bev:' || cs.kk)))::numeric, 2) END AS beverage,
                   CASE WHEN cs.outlet_type = 'retail' THEN round((cs.avg_per_cover * exp(0.6 * cdp_mock.n('merch:' || cs.kk)))::numeric, 2) ELSE 0 END AS merchandise,
                   CASE WHEN NOT cs.carded THEN cdp_mock.wpick('pay:' || cs.kk, '{Card,Cash}', '{75,25}')
                        WHEN hs.stay_id IS NOT NULL AND cdp_mock.u('roomchg:' || cs.kk) < 0.35 THEN 'Room Charge'
                        WHEN cdp_mock.u('comp:' || cs.kk) < 0.05 + 0.12 * (cs.tier_rank - 1) + CASE cs.outlet_type WHEN 'fine_dining' THEN 0.10 ELSE 0 END THEN 'Comp'
                        WHEN cdp_mock.u('points:' || cs.kk) < 0.08 THEN 'Points'
                        ELSE cdp_mock.wpick('pay:' || cs.kk, '{Card,Cash}', '{75,25}') END AS payment_type,
                   CASE WHEN cs.carded THEN hs.stay_id END AS stay_id,
                   CASE WHEN cs.carded THEN cs.visit_id END AS mock_visit_id
            FROM (
                SELECT cs.*, cs.k AS kk, true AS carded FROM check_stage cs
                UNION ALL
                -- Uncarded check for about every third carded one: same outlet and day,
                -- another guest (own time, amounts and payment), no account number.
                SELECT cs.*, cs.k || ':u', false FROM check_stage cs WHERE cdp_mock.u('uncarded:' || cs.k) < 0.35
            ) cs
            LEFT JOIN cdp_mock.hotel_stay hs ON hs.mock_visit_id = cs.visit_id AND hs.status = 'Checked Out'
        ) c
    ) x
) y;

CREATE INDEX ON cdp_mock.pos_check (account_number);
CREATE INDEX ON cdp_mock.pos_check (site_code, opened_at);

-- ---------------------------------------------------------------- spa

CREATE TABLE cdp_mock.spa_appointment (
    appointment_id   bigint PRIMARY KEY,
    source_system    text NOT NULL,
    site_code        text NOT NULL REFERENCES cdp_mock.site,
    property_id      text NOT NULL,
    account_number   numeric REFERENCES cdp_mock.player,
    service_category text NOT NULL,
    service_name     text NOT NULL,
    duration_minutes integer NOT NULL,
    booked_at        timestamptz NOT NULL,
    appointment_at   timestamptz NOT NULL,
    price            numeric(8,2) NOT NULL,
    comp_amount      numeric(8,2) NOT NULL,
    tip_amount       numeric(8,2) NOT NULL,
    payment_type     text NOT NULL,
    status           text NOT NULL CHECK (status IN ('Completed', 'Cancelled', 'No Show')),
    stay_id          bigint REFERENCES cdp_mock.hotel_stay,
    mock_visit_id    bigint REFERENCES cdp_mock.visit
);
COMMENT ON TABLE cdp_mock.spa_appointment IS 'MOCK. Spa services during hotel stays at the spa sites (Agilysys Spa placeholder).';

INSERT INTO cdp_mock.spa_appointment
SELECT row_number() OVER (ORDER BY appointment_at, k),
       'Agilysys Spa', site_code, property_id, account_number, service_category, service_name, duration_minutes,
       appointment_at - make_interval(days => ceil(cdp_mock.expo('spalead:' || k, 5))::integer),
       appointment_at, price,
       CASE WHEN payment_type = 'Comp' AND status = 'Completed' THEN price ELSE 0 END,
       CASE WHEN payment_type <> 'Comp' AND status = 'Completed' THEN round(price * 0.2, 2) ELSE 0 END,
       payment_type, status, stay_id, visit_id
FROM (
    SELECT s.*,
           cdp_mock.at_site(s.visit_date + floor(cdp_mock.u('spaday:' || s.k) * s.days)::integer,
                            cdp_mock.clock('spatime:' || s.k, 9, 9)) AS appointment_at,
           CASE svc.category WHEN 'Massage' THEN 140 WHEN 'Facial' THEN 125 WHEN 'Body Treatment' THEN 150 WHEN 'Nail' THEN 50 ELSE 70 END
               * CASE svc.duration WHEN 80 THEN 1.45 ELSE 1 END AS price,
           svc.category AS service_category, svc.name AS service_name, svc.duration AS duration_minutes,
           CASE WHEN cdp_mock.u('spacomp:' || s.k) < CASE s.tier_rank WHEN 3 THEN 0.40 WHEN 2 THEN 0.15 ELSE 0.03 END THEN 'Comp'
                ELSE cdp_mock.wpick('spapay:' || s.k, '{Card,Room Charge}', '{50,50}') END AS payment_type,
           cdp_mock.wpick('spastatus:' || s.k, '{Completed,Cancelled,No Show}', '{90,7,3}') AS status
    FROM (
        SELECT v.*, hs.stay_id, v.visit_id || ':' || j AS k
        FROM visit_ctx v
        JOIN cdp_mock.hotel_stay hs ON hs.mock_visit_id = v.visit_id AND hs.status = 'Checked Out'
        CROSS JOIN LATERAL generate_series(1, 1 + (cdp_mock.u('spa2:' || v.visit_id) < 0.3)::integer) j
        WHERE v.has_spa
          AND cdp_mock.u('spa:' || v.visit_id) < CASE v.site_code WHEN 'ARTESIAN' THEN 0.35 ELSE 0.12 END * (1 + 0.3 * (v.tier_rank - 1))
    ) s
    CROSS JOIN LATERAL (
        SELECT split_part(x, '|', 1) AS category, split_part(x, '|', 2) AS name, split_part(x, '|', 3)::integer AS duration
        FROM (SELECT cdp_mock.wpick('spasvc:' || s.k,
                '{Massage|Swedish Massage|50,Massage|Deep Tissue Massage|80,Massage|Hot Stone Massage|80,Facial|Signature Facial|50,Body Treatment|Body Wrap|50,Nail|Manicure|50,Nail|Pedicure|50,Salon|Blowout|50}',
                '{25,15,10,20,10,8,7,5}') AS x) z
    ) svc
) a;

CREATE INDEX ON cdp_mock.spa_appointment (account_number);

-- ---------------------------------------------------------------- golf

CREATE TABLE cdp_mock.golf_round (
    round_id          bigint PRIMARY KEY,
    source_system     text NOT NULL,
    site_code         text NOT NULL REFERENCES cdp_mock.site,
    property_id       text NOT NULL,
    account_number    numeric REFERENCES cdp_mock.player,
    booked_at         timestamptz NOT NULL,
    tee_time          timestamptz NOT NULL,
    holes             integer NOT NULL,
    players_in_group  integer NOT NULL,
    green_fee         numeric(8,2) NOT NULL,
    cart_fee          numeric(8,2) NOT NULL,
    comp_amount       numeric(8,2) NOT NULL,
    status            text NOT NULL CHECK (status IN ('Completed', 'Cancelled', 'No Show')),
    mock_visit_id     bigint REFERENCES cdp_mock.visit
);
COMMENT ON TABLE cdp_mock.golf_round IS 'MOCK. Golf rounds at WinStar (Agilysys Golf placeholder). Fees are for the member only, not the group.';

INSERT INTO cdp_mock.golf_round
SELECT row_number() OVER (ORDER BY tee_time, visit_id),
       'Agilysys Golf', site_code, property_id, account_number,
       tee_time - make_interval(days => ceil(cdp_mock.expo('golflead:' || visit_id, 7))::integer),
       tee_time, holes, players_in_group, green_fee, cart_fee,
       CASE WHEN comped AND status = 'Completed' THEN green_fee + cart_fee ELSE 0 END, status, visit_id
FROM (
    SELECT v.*,
           cdp_mock.at_site(v.visit_date + floor(cdp_mock.u('golfday:' || v.visit_id) * v.days)::integer,
                            cdp_mock.clock('tee:' || v.visit_id, 7, 9)) AS tee_time,
           CASE WHEN cdp_mock.u('holes:' || v.visit_id) < 0.85 THEN 18 ELSE 9 END AS holes,
           greatest(v.party_size, cdp_mock.wpick('group:' || v.visit_id, '{1,2,3,4}', '{10,30,20,40}')::integer) AS players_in_group,
           CASE WHEN cdp_mock.u('holes:' || v.visit_id) < 0.85
                THEN CASE WHEN extract(isodow FROM v.visit_date) IN (6, 7) THEN 129 ELSE 99 END ELSE 49 END AS green_fee,
           CASE WHEN cdp_mock.u('holes:' || v.visit_id) < 0.85 THEN 25 ELSE 15 END AS cart_fee,
           cdp_mock.u('golfcomp:' || v.visit_id) < CASE v.tier_rank WHEN 3 THEN 0.50 WHEN 2 THEN 0.20 ELSE 0.05 END AS comped,
           cdp_mock.wpick('golfstatus:' || v.visit_id, '{Completed,Cancelled,No Show}', '{92,6,2}') AS status
    FROM visit_ctx v
    WHERE v.has_golf
      AND cdp_mock.u('golf:' || v.visit_id)
          < CASE WHEN v.nights > 0 THEN 0.10 ELSE 0.03 END * (1 + 0.5 * (v.tier_rank - 1))
            * CASE WHEN extract(month FROM v.visit_date) IN (12, 1, 2) THEN 0.3 WHEN extract(month FROM v.visit_date) IN (6, 7, 8) THEN 0.8 ELSE 1 END
) g;

CREATE INDEX ON cdp_mock.golf_round (account_number);

COMMIT;
