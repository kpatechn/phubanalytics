-- MOCK DATA: contact points and marketing opt-ins. Chickasaw keeps no opt-ins today, so
-- this is a proposal for what the CDP would hold, filled with mock history:
--   contact_point   one row per player email / mobile on file (reserved example values)
--   consent_event   append-only ledger: every opt-in and opt-out, with where it came from
--   v_consent_current  latest status per player, channel and purpose
-- No row for a channel means no consent. Push opt-ins are added by 40_app.sql.
-- Self-excluded players keep their mock opt-ins on purpose: the CDP must suppress them.

BEGIN;

CREATE TABLE cdp_mock.contact_point (
    account_number numeric NOT NULL REFERENCES cdp_mock.player,
    channel        text NOT NULL CHECK (channel IN ('email', 'mobile')),
    value          text NOT NULL,
    is_primary     boolean NOT NULL,
    verified_at    timestamptz,
    source         text NOT NULL,
    PRIMARY KEY (account_number, channel, value)
);
COMMENT ON TABLE cdp_mock.contact_point IS 'MOCK. Emails are @example.com and mobiles use the unassigned +1 555 area code.';

INSERT INTO cdp_mock.contact_point
SELECT pl.account_number, c.channel, c.value, true,
       CASE WHEN cdp_mock.u('verified:' || c.channel || ':' || pl.account_number) < CASE c.channel WHEN 'email' THEN 0.60 ELSE 0.70 END
            THEN cdp_mock.at_site(pl.signup_date + ceil(cdp_mock.expo('verday:' || c.channel || ':' || pl.account_number, 20))::integer,
                                  cdp_mock.clock('vertime:' || c.channel || ':' || pl.account_number, 8, 14)) END,
       'players_club_desk'
FROM cdp_mock.player pl
CROSS JOIN LATERAL (VALUES ('email', cdp_mock.player_email(pl.account_number)),
                           ('mobile', cdp_mock.player_mobile(pl.account_number))) c(channel, value)
WHERE c.value IS NOT NULL;

CREATE TABLE cdp_mock.consent_event (
    consent_event_id bigint PRIMARY KEY,
    account_number   numeric NOT NULL REFERENCES cdp_mock.player,
    channel          text NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'mail')),
    purpose          text NOT NULL CHECK (purpose IN ('marketing')),
    status           text NOT NULL CHECK (status IN ('opt_in', 'opt_out')),
    contact_value    text,                 -- the address or number the choice applies to
    source           text NOT NULL,        -- where it was captured
    site_code        text REFERENCES cdp_mock.site,
    captured_at      timestamptz NOT NULL,
    policy_version   text NOT NULL,
    evidence         text NOT NULL,
    captured_by      text NOT NULL CHECK (captured_by IN ('guest', 'staff', 'system'))
);
COMMENT ON TABLE cdp_mock.consent_event IS 'MOCK. Append-only opt-in / opt-out ledger. Latest row per account, channel and purpose wins (v_consent_current).';

CREATE TEMP TABLE consent_stage (
    account_number numeric, channel text, status text, contact_value text, source text, site_code text,
    captured_at timestamptz, evidence text, captured_by text
) ON COMMIT DROP;

-- Home site for desk and kiosk sign-ups: WinStar for Texans and anyone with no other
-- visits, otherwise the site the player visits most.
CREATE TEMP TABLE home_site ON COMMIT DROP AS
SELECT pl.account_number,
       coalesce((SELECT v.site_code FROM cdp_mock.visit v WHERE v.account_number = pl.account_number AND pl.home_region <> 'TX'
                 GROUP BY v.site_code ORDER BY count(*) DESC, v.site_code LIMIT 1), 'WINSTAR') AS site_code
FROM cdp_mock.player pl;
ALTER TABLE home_site ADD PRIMARY KEY (account_number);

-- Choice made at sign-up (or nothing captured), per channel.
WITH signup AS (
    SELECT pl.account_number, pl.signup_date, h.site_code, ch.channel,
           CASE ch.channel WHEN 'email' THEN cdp_mock.player_email(pl.account_number)
                           WHEN 'sms' THEN cdp_mock.player_mobile(pl.account_number) END AS contact_value,
           cdp_mock.u('signupchoice:' || ch.channel || ':' || pl.account_number) AS r,
           cdp_mock.wpick('signupsrc:' || pl.account_number, '{players_club_desk,kiosk,website}', '{60,25,15}') AS source
    FROM cdp_mock.player pl
    JOIN home_site h USING (account_number)
    CROSS JOIN (VALUES ('email'), ('sms'), ('mail')) ch(channel)
)
INSERT INTO consent_stage
SELECT account_number, channel,
       CASE WHEN r < CASE channel WHEN 'email' THEN 0.62 WHEN 'sms' THEN 0.38 ELSE 0.80 END THEN 'opt_in' ELSE 'opt_out' END,
       contact_value, source, CASE WHEN source = 'website' THEN NULL ELSE site_code END,
       cdp_mock.at_site(signup_date, cdp_mock.clock('signuptime:' || account_number, 9, 13)),
       CASE source WHEN 'players_club_desk' THEN 'signed enrollment form'
                   WHEN 'kiosk' THEN 'kiosk enrollment checkbox'
                   ELSE 'web enrollment checkbox' END,
       CASE source WHEN 'players_club_desk' THEN 'staff' ELSE 'guest' END
FROM signup
WHERE (channel = 'mail' OR contact_value IS NOT NULL)
  -- Some sign-ups recorded no answer for the channel at all.
  AND r < CASE channel WHEN 'email' THEN 0.72 WHEN 'sms' THEN 0.50 ELSE 0.85 END;

-- Changes inside the window: unsubscribes and STOP replies by those opted in,
-- later opt-ins (web, kiosk, JOIN keyword) by those who weren't.
INSERT INTO consent_stage
SELECT c.account_number, c.channel,
       CASE c.status WHEN 'opt_in' THEN 'opt_out' ELSE 'opt_in' END,
       c.contact_value,
       CASE WHEN c.status = 'opt_in' THEN CASE c.channel WHEN 'email' THEN 'email_unsubscribe' WHEN 'sms' THEN 'sms_keyword' ELSE 'call_center' END
            ELSE CASE c.channel WHEN 'sms' THEN 'sms_keyword' ELSE cdp_mock.wpick('latersrc:' || c.account_number, '{website,kiosk}', '{70,30}') END END,
       NULL,
       cdp_mock.at_site(d.change_date, cdp_mock.clock('changetime:' || c.channel || ':' || c.account_number, 8, 15)),
       CASE WHEN c.status = 'opt_in' THEN CASE c.channel WHEN 'email' THEN 'unsubscribe link' WHEN 'sms' THEN 'STOP reply' ELSE 'call center request' END
            ELSE CASE c.channel WHEN 'sms' THEN 'JOIN reply' ELSE 'preference center' END END,
       CASE WHEN c.status = 'opt_in' AND c.channel = 'mail' THEN 'staff' ELSE 'guest' END
FROM consent_stage c
JOIN cdp_mock.player pl USING (account_number)
CROSS JOIN cdp_mock.params p
CROSS JOIN LATERAL (
    SELECT greatest(p.start_date, pl.signup_date + 1)
           + floor(cdp_mock.u('changeday:' || c.channel || ':' || c.account_number)
                   * (p.end_date - greatest(p.start_date, pl.signup_date + 1)))::integer AS change_date
) d
WHERE (c.channel <> 'mail' OR c.status = 'opt_in')
  AND cdp_mock.u('change:' || c.channel || ':' || c.account_number)
      < CASE WHEN c.status = 'opt_in' THEN CASE c.channel WHEN 'email' THEN 0.07 WHEN 'sms' THEN 0.08 ELSE 0.03 END
             ELSE CASE c.channel WHEN 'email' THEN 0.04 ELSE 0.05 END END
  AND greatest(p.start_date, pl.signup_date + 1) < p.end_date;

INSERT INTO cdp_mock.consent_event
SELECT row_number() OVER (ORDER BY captured_at, account_number, channel),
       account_number, channel, 'marketing', status, contact_value, source, site_code, captured_at,
       CASE WHEN captured_at < '2020-01-01' THEN 'v2019.1' WHEN captured_at < '2025-01-01' THEN 'v2023.1' ELSE 'v2025.1' END,
       evidence, captured_by
FROM consent_stage;

CREATE INDEX ON cdp_mock.consent_event (account_number, channel, purpose, captured_at DESC);

CREATE VIEW cdp_mock.v_consent_current AS
SELECT DISTINCT ON (account_number, channel, purpose)
       account_number, channel, purpose, status, contact_value, source, site_code, captured_at, policy_version
FROM cdp_mock.consent_event
ORDER BY account_number, channel, purpose, captured_at DESC, consent_event_id DESC;
COMMENT ON VIEW cdp_mock.v_consent_current IS 'MOCK. Latest consent per player, channel and purpose. Does not apply self-exclusion: join dexiga.exclusion_history for that.';

COMMIT;
