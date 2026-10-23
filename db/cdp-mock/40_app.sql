-- MOCK DATA: the Chickasaw app. Kept here in GEM, never in Graton's dexl, so the two
-- clients' data never mix.
--   app_user   PlayerHub account (userId) per app user, linked to a Club Passport number
--              or not yet linked (account_number NULL)
--   app_event  events in exactly the columns and types of dexl data."dexAnalytics",
--              tenant 16001 (placeholder), propertyId = the site's PlayerHub property
-- Event IDs and attribute keys follow db/seeds/001_event_catalog.sql and what Graton's
-- app sends. Sessions happen on visit days (onsite) and on other days (offsite).
-- Also appends push opt-ins / opt-outs to consent_event.

BEGIN;

CREATE TABLE cdp_mock.app_user (
    user_id             uuid PRIMARY KEY,
    account_number      numeric UNIQUE REFERENCES cdp_mock.player,   -- NULL = card never linked
    home_site_code      text NOT NULL REFERENCES cdp_mock.site,
    platform            text NOT NULL CHECK (platform IN ('ios', 'android')),
    app_version         text NOT NULL,
    first_seen_at       timestamptz NOT NULL,
    linked_at           timestamptz,
    push_permission     boolean NOT NULL,
    location_permission boolean NOT NULL,
    marketing_consent   boolean NOT NULL,   -- the in-app consent sent on every event
    engagement          double precision NOT NULL
);
COMMENT ON TABLE cdp_mock.app_user IS 'MOCK. Chickasaw app users. user_id plays the role of the PlayerHub account ("userId" on events).';

-- Adoption: 12% of Texans, 22% of Oklahomans, 6% of others, up to twice that for higher tiers.
-- Plus guests who installed the app but never linked a card (one for every ~7 linked users).
INSERT INTO cdp_mock.app_user
WITH linked AS (
    SELECT pl.account_number, pl.home_region, t.tier_rank
    FROM cdp_mock.player pl
    JOIN cdp_mock.tier t USING (card_level)
    WHERE cdp_mock.u('app:' || pl.account_number)
          < CASE pl.home_region WHEN 'TX' THEN 0.12 WHEN 'OK' THEN 0.22 ELSE 0.06 END * (1 + 0.5 * (t.tier_rank - 1))
),
users AS (
    SELECT cdp_mock.uuid('appuser:' || l.account_number) AS user_id, l.account_number,
           coalesce((SELECT v.site_code FROM cdp_mock.visit v WHERE v.account_number = l.account_number AND l.home_region <> 'TX'
                     GROUP BY v.site_code ORDER BY count(*) DESC, v.site_code LIMIT 1), 'WINSTAR') AS home_site_code,
           'appuser:' || l.account_number AS k
    FROM linked l
    UNION ALL
    SELECT cdp_mock.uuid('appanon:' || g), NULL,
           cdp_mock.wpick('anonsite:' || g, '{WINSTAR,RIVERWIND,REMINGTON,GOLDMTN,NEWCASTLE}', '{60,15,10,8,7}'),
           'appanon:' || g
    FROM generate_series(1, (SELECT (count(*) * 0.15)::integer FROM linked)) g
)
SELECT u.user_id, u.account_number, u.home_site_code,
       cdp_mock.wpick('platform:' || u.k, '{ios,android}', '{60,40}'),
       cdp_mock.wpick('version:' || u.k, '{3.4.2,3.4.1,3.3.0,3.2.5}', '{50,25,15,10}'),
       f.first_seen_at,
       CASE WHEN u.account_number IS NOT NULL
            THEN f.first_seen_at + make_interval(secs => cdp_mock.expo('linkdelay:' || u.k, 3 * 86400)) END,
       cdp_mock.u('pushperm:' || u.k) < 0.62,
       cdp_mock.u('locperm:' || u.k) < 0.45,
       cdp_mock.u('mktconsent:' || u.k) < 0.55,
       exp(0.6 * cdp_mock.n('engage:' || u.k) - 0.18)
FROM users u
CROSS JOIN cdp_mock.params p
CROSS JOIN LATERAL (
    -- Four in ten installed before the window; the rest join during it.
    SELECT CASE WHEN cdp_mock.u('early:' || u.k) < 0.4
                THEN cdp_mock.at_site(p.start_date - (cdp_mock.u('installday:' || u.k) * 365)::integer, cdp_mock.clock('installtime:' || u.k, 8, 15))
                ELSE cdp_mock.at_site(p.start_date + (cdp_mock.u('installday:' || u.k) * (p.end_date - p.start_date) * 0.9)::integer,
                                      cdp_mock.clock('installtime:' || u.k, 8, 15)) END AS first_seen_at
) f;

CREATE INDEX ON cdp_mock.app_user (home_site_code);

-- Push opt-in from the OS permission at linking; one in twenty later switches it off.
INSERT INTO cdp_mock.consent_event
SELECT (SELECT coalesce(max(consent_event_id), 0) FROM cdp_mock.consent_event)
         + row_number() OVER (ORDER BY e.captured_at, e.account_number, e.status),
       e.account_number, 'push', 'marketing', e.status, 'app:' || e.user_id, 'mobile_app', NULL, e.captured_at,
       CASE WHEN e.captured_at < '2025-01-01' THEN 'v2023.1' ELSE 'v2025.1' END, e.evidence, 'guest'
FROM (
    SELECT a.account_number, a.user_id, a.linked_at AS captured_at,
           CASE WHEN a.push_permission THEN 'opt_in' ELSE 'opt_out' END AS status,
           'OS notification permission at account link' AS evidence
    FROM cdp_mock.app_user a WHERE a.account_number IS NOT NULL
    UNION ALL
    SELECT a.account_number, a.user_id,
           a.linked_at + make_interval(days => 1 + floor(cdp_mock.u('pushoffday:' || a.user_id)
                                                          * greatest(1, extract(day FROM p.end_date - a.linked_at)))::integer),
           'opt_out', 'notification settings turned off'
    FROM cdp_mock.app_user a CROSS JOIN cdp_mock.params p
    WHERE a.account_number IS NOT NULL AND a.push_permission
      AND cdp_mock.u('pushoff:' || a.user_id) < 0.05
      AND a.linked_at < p.end_date - 1
) e;

-- Same columns and types as dexl data."dexAnalytics".
CREATE TABLE cdp_mock.app_event (
    id                uuid NOT NULL PRIMARY KEY,
    "propertyId"      integer NOT NULL,
    "tenantId"        integer NOT NULL,
    "sessionId"       uuid NOT NULL,
    "userId"          character varying NOT NULL,
    "eventId"         character varying NOT NULL,
    "mobileName"      character varying NOT NULL DEFAULT 'NA',
    "eventVersion"    character varying,
    "schemaRelease"   character varying,
    "correlationId"   character varying,
    "transactionId"   character varying,
    "campaignId"      character varying,
    "messageId"       character varying,
    traceparent       character varying,
    latitude          double precision,
    longitude         double precision,
    "locationContext" character varying,
    consent           jsonb,
    attributes        jsonb,
    "createdDate"     timestamptz NOT NULL,
    "rawPayload"      jsonb
);
COMMENT ON TABLE cdp_mock.app_event IS 'MOCK. Chickasaw app events in the dexl data."dexAnalytics" shape. No coordinates and no raw payloads.';

-- Active days: visit days after install (7 in 10 open the app), plus offsite days spread
-- over the window (more for engaged users; unlinked guests rarely come back).
CREATE TEMP TABLE app_day ON COMMIT DROP AS
SELECT DISTINCT ON (user_id, day) *
FROM (
    SELECT a.user_id, v.visit_date + floor(cdp_mock.u('vday:' || v.visit_id) * (v.nights + 1))::integer AS day,
           true AS onsite, v.site_code, v.arrival_time, v.visit_id
    FROM cdp_mock.app_user a
    JOIN cdp_mock.visit v ON v.account_number = a.account_number AND v.visit_date >= a.first_seen_at::date
    WHERE cdp_mock.u('openonsite:' || v.visit_id) < 0.7
    UNION ALL
    SELECT a.user_id,
           greatest(p.start_date, a.first_seen_at::date)
             + floor(cdp_mock.u('offday:' || a.user_id || ':' || g) * (p.end_date - greatest(p.start_date, a.first_seen_at::date) + 1))::integer,
           false, a.home_site_code, NULL::time, NULL::bigint
    FROM cdp_mock.app_user a
    CROSS JOIN cdp_mock.params p
    CROSS JOIN LATERAL generate_series(1, round(cdp_mock.expo('noff:' || a.user_id,
                                       CASE WHEN a.account_number IS NULL THEN 1.5 ELSE 3 * a.engagement END))::integer) g
) d
ORDER BY user_id, day, onsite DESC, visit_id;

CREATE TEMP TABLE app_session ON COMMIT DROP AS
SELECT d.*, a.account_number, a.location_permission, a.marketing_consent, a.linked_at, s.playerhub_tenant_id,
       s.playerhub_property_id, s.site_name, t.tier_name, n AS session_no,
       cdp_mock.uuid('sess:' || d.user_id || ':' || d.day || ':' || n) AS session_id,
       d.user_id || ':' || d.day || ':' || n AS k,
       cdp_mock.at_site(d.day, CASE WHEN d.onsite THEN d.arrival_time + make_interval(mins => floor(cdp_mock.u('sstart:' || d.user_id || d.day || n) * 240)::integer)
                                    ELSE cdp_mock.clock('sstart:' || d.user_id || d.day || n, 7, 17) END) AS started_at
FROM app_day d
JOIN cdp_mock.app_user a USING (user_id)
JOIN cdp_mock.site s USING (site_code)
LEFT JOIN cdp_mock.player pl ON pl.account_number = a.account_number
LEFT JOIN cdp_mock.tier t ON t.card_level = pl.card_level
CROSS JOIN LATERAL generate_series(1, 1 + (cdp_mock.u('s2:' || d.user_id || d.day) < 0.3)::integer
                                         + (cdp_mock.u('s3:' || d.user_id || d.day) < 0.08)::integer) n;

-- Each session: start, open, sometimes a push open / login / geofence entry, two to seven
-- screens and taps, then background and end.
INSERT INTO cdp_mock.app_event (id, "propertyId", "tenantId", "sessionId", "userId", "eventId", "mobileName",
                                "eventVersion", "schemaRelease", "campaignId", "messageId", "locationContext",
                                consent, attributes, "createdDate")
SELECT cdp_mock.uuid('evt:' || e.k || ':' || e.idx),
       e.playerhub_property_id, e.playerhub_tenant_id, e.session_id, e.user_id::text, e.event_id,
       coalesce(e.mobile_name, 'NA'), '1', '1.0',
       CASE WHEN e.event_id = 'push_opened' THEN e.campaign_id END,
       CASE WHEN e.event_id = 'push_opened' THEN 'MSG-' || e.campaign_id || '-' || left(md5(e.k), 8) END,
       CASE WHEN e.onsite THEN 'onsite' ELSE 'offsite' END,
       jsonb_build_object('analytics', true, 'marketing', e.marketing_consent),
       e.attributes,
       e.started_at + make_interval(secs => (e.idx - 1) * 25 + floor(cdp_mock.u('gap:' || e.k || ':' || e.idx) * 20)::integer)
FROM (
    SELECT x.*, ev.event_id, ev.idx, x.screen_for[ev.idx] AS screen,
           -- Attributes and mobileName per event type, as the app sends them.
           CASE ev.event_id
               WHEN 'page_open' THEN jsonb_build_object('screen_name', x.screen_for[ev.idx], 'route', '/' || x.screen_for[ev.idx], 'previous_screen', 'home')
               WHEN 'button_clicked' THEN jsonb_build_object('label', x.label_for[ev.idx], 'screen_name', x.screen_for[ev.idx])
               WHEN 'login_completed' THEN jsonb_build_object('auth_method', cdp_mock.wpick('auth:' || x.k, '{biometric,pin,password}', '{55,30,15}'), 'player_id', x.account_number::text)
               WHEN 'tier_status_viewed' THEN jsonb_build_object('tier_status', x.tier_name, 'player_id', x.account_number::text)
               WHEN 'geofence_entered' THEN jsonb_build_object('geofence_name', x.site_name, 'zone_name', 'Main Entrance', 'event_type', 'entry')
               WHEN 'push_opened' THEN jsonb_build_object('campaign_id', x.campaign_id, 'platform', 'mobile')
               WHEN 'pull_to_refresh' THEN jsonb_build_object('page', x.screen_for[ev.idx], 'tier_status', x.tier_name)
               WHEN 'notification_list_viewed' THEN jsonb_build_object('screen_name', 'inbox', 'unread_count', floor(cdp_mock.u('unread:' || x.k) * 6)::integer)
               WHEN 'notification_details_viewed' THEN jsonb_build_object('title', x.promo_for[ev.idx], 'is_cta_completed', cdp_mock.u('cta:' || x.k || ev.idx) < 0.3)
               WHEN 'promotion_details_viewed' THEN jsonb_build_object('promo_title', x.promo_for[ev.idx], 'time_spent_ms', floor(2000 + cdp_mock.expo('dwell:' || x.k || ev.idx, 15000))::integer)
               WHEN 'event_details_viewed' THEN jsonb_build_object('event_title', x.show_for[ev.idx], 'time_spent_ms', floor(2000 + cdp_mock.expo('dwell:' || x.k || ev.idx, 12000))::integer)
               ELSE '{}'::jsonb
           END AS attributes,
           CASE ev.event_id
               WHEN 'button_clicked' THEN x.label_for[ev.idx]
               WHEN 'promotion_details_viewed' THEN x.promo_for[ev.idx]
               WHEN 'notification_details_viewed' THEN x.promo_for[ev.idx]
               WHEN 'event_details_viewed' THEN x.show_for[ev.idx]
               WHEN 'page_open' THEN x.screen_for[ev.idx]
           END AS mobile_name
    FROM (
        SELECT s.*,
               'CMP-' || (1001 + floor(cdp_mock.u('campaign:' || s.k) * 40)::integer) AS campaign_id,
               ARRAY['session_started', 'app_opened']
                 || CASE WHEN cdp_mock.u('frompush:' || s.k) < 0.10 AND s.account_number IS NOT NULL THEN ARRAY['push_opened'] ELSE '{}'::text[] END
                 || CASE WHEN s.session_no = 1 AND cdp_mock.u('login:' || s.k) < 0.25 AND s.account_number IS NOT NULL THEN ARRAY['login_completed'] ELSE '{}'::text[] END
                 || CASE WHEN s.onsite AND s.session_no = 1 AND s.location_permission THEN ARRAY['geofence_entered'] ELSE '{}'::text[] END
                 || (SELECT array_agg(CASE WHEN s.account_number IS NULL AND cdp_mock.u('linkcta:' || s.k || i) < 0.25 THEN 'link_account_clicked'
                                           ELSE cdp_mock.wpick('action:' || s.k || ':' || i,
                        '{page_open,button_clicked,tier_status_viewed,offer_list_viewed,promotion_details_viewed,wallet_screen_viewed,wallet_balance_checked,notification_list_viewed,notification_details_viewed,event_details_viewed,restaurant_list_viewed,pull_to_refresh,resort_info_viewed,gaming_hub_screen_viewed}',
                        CASE WHEN s.account_number IS NULL THEN '{35,20,0,8,8,0,0,6,3,6,6,4,4,0}'::float8[]
                             ELSE '{30,15,6,6,5,5,3,5,3,3,3,4,2,2}'::float8[] END) END ORDER BY i)
                     FROM generate_series(1, 2 + floor(cdp_mock.u('nactions:' || s.k) * 6)::integer) i)
                 || ARRAY['app_backgrounded', 'session_ended'] AS events,
               -- Per-position picks, used by the attribute builder above.
               (SELECT array_agg(cdp_mock.pick('screen:' || s.k || ':' || i, '{home,offers,promotions,tier_status,wallet,dining,events,hotel,gaming,inbox,account_settings}') ORDER BY i)
                FROM generate_series(1, 16) i) AS screen_for,
               (SELECT array_agg(cdp_mock.pick('label:' || s.k || ':' || i, '{VIEW ALL,MY OFFERS,BOOK NOW,VIEW MENU,CLAIM,MAKE RESERVATION,LINK ACCOUNT,SETTINGS,DINING,PROMOTIONS}') ORDER BY i)
                FROM generate_series(1, 16) i) AS label_for,
               (SELECT array_agg(cdp_mock.pick('promo:' || s.k || ':' || i, '{Weekly Free Play Drawing,Hot Seat Fridays,Tier Match Offer,Birthday Free Play,Dining Credit Offer,Slot Tournament,Hotel Getaway Offer,Points Multiplier Day}') ORDER BY i)
                FROM generate_series(1, 16) i) AS promo_for,
               (SELECT array_agg(cdp_mock.pick('show:' || s.k || ':' || i, '{Country Night Concert,Comedy Showcase,Boxing Night,Tribute Band Live,New Year Celebration}') ORDER BY i)
                FROM generate_series(1, 16) i) AS show_for
        FROM app_session s
    ) x
    CROSS JOIN LATERAL unnest(x.events) WITH ORDINALITY AS ev(event_id, idx)
) e;

CREATE INDEX ON cdp_mock.app_event ("userId", "createdDate");
CREATE INDEX ON cdp_mock.app_event ("createdDate");

COMMIT;
