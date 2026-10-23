import type {
  CdpActivity,
  CdpChannel,
  CdpChannelReach,
  CdpExample,
  CdpFeed,
  CdpMeta,
  CdpPlayer,
  CdpPlayerHost,
  CdpPlayerReach,
  CdpPlayerSite,
  CdpPreferences,
  CdpSegment,
  CdpSegmentsData,
  CdpSite,
  CdpSitesData,
} from '@phub/contracts';
import type { Sql } from './db.js';

// Chickasaw CDP prototype: every query reads schema cdp in the GEM dev database (dexiga),
// which cdp.refresh() rebuilds from the WinStar loyalty data and the cdp_mock feeds.
// Dates are cast to text (YYYY-MM-DD) in SQL; timestamps arrive as Date.

export type CdpMetaBase = Omit<CdpMeta, 'generatedAt'>;

export interface CdpRepo {
  /** Null until cdp.refresh() has finished once. */
  meta(): Promise<CdpMetaBase | null>;
  segments(): Promise<CdpSegmentsData>;
  sites(): Promise<CdpSitesData>;
  /** Null for an unknown segment. */
  examples(segment: string): Promise<CdpExample[] | null>;
  /** Null for an account with no profile. */
  player(accountNumber: string): Promise<CdpPlayer | null>;
}

export const CDP_CHANNELS: CdpChannel[] = ['email', 'sms', 'push', 'mail'];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function createCdpRepo(sql: Sql, client: string): CdpRepo {
  return {
    async meta() {
      const [run] = await sql<{ asOfDate: string; windowFrom: string; refreshedAt: Date }[]>`
        SELECT as_of_date::text AS "asOfDate", (as_of_date - 364)::text AS "windowFrom", finished_at AS "refreshedAt"
        FROM cdp.refresh_run WHERE finished_at IS NOT NULL ORDER BY run_id DESC LIMIT 1`;
      if (!run) return null;
      const [feeds, sites] = await Promise.all([
        sql<CdpFeed[]>`SELECT feed_code AS code, area, source, is_mock AS "isMock", notes FROM cdp.feed ORDER BY is_mock, area, feed_code`,
        sql<CdpMeta['sites']>`
          SELECT s.site_code AS code, s.site_name AS name, f.is_mock AS "gamingIsMock"
          FROM cdp.site s JOIN cdp.feed f ON f.feed_code = s.gaming_feed
          ORDER BY f.is_mock, s.site_code`,
      ]);
      return { client, asOfDate: run.asOfDate, windowFrom: run.windowFrom, refreshedAt: run.refreshedAt.toISOString(), feeds: [...feeds], sites: [...sites] };
    },

    async segments() {
      const [[totals], channels, segments] = await Promise.all([
        sql<CdpSegmentsData['totals'][]>`
          SELECT count(*) AS players,
                 count(*) FILTER (WHERE visit_days_12m > 0) AS active,
                 count(*) FILTER (WHERE is_marketable) AS marketable,
                 count(*) FILTER (WHERE sites_visited_12m >= 2) AS "multiSite",
                 count(*) FILTER (WHERE is_excluded) AS "selfExcluded",
                 count(*) FILTER (WHERE app_user_id IS NOT NULL) AS "appLinked"
          FROM cdp.player_profile`,
        sql<CdpChannelReach[]>`
          SELECT channel,
                 count(*) FILTER (WHERE reason = 'reachable') AS reachable,
                 count(*) FILTER (WHERE reason = 'self_excluded') AS "selfExcluded",
                 count(*) FILTER (WHERE reason = 'no_contact') AS "noContact",
                 count(*) FILTER (WHERE reason = 'opted_out') AS "optedOut",
                 count(*) FILTER (WHERE reason = 'no_consent') AS "noConsent"
          FROM cdp.reachability
          GROUP BY channel
          ORDER BY array_position(${CDP_CHANNELS}::text[], channel)`,
        sql<(Omit<CdpSegment, 'reach'> & Record<CdpChannel, number>)[]>`
          SELECT s.segment_code AS code, s.name, s.description, s.rule,
                 count(m.account_number) AS members,
                 count(*) FILTER (WHERE 'email' = ANY (p.reachable_channels)) AS email,
                 count(*) FILTER (WHERE 'sms' = ANY (p.reachable_channels)) AS sms,
                 count(*) FILTER (WHERE 'push' = ANY (p.reachable_channels)) AS push,
                 count(*) FILTER (WHERE 'mail' = ANY (p.reachable_channels)) AS mail,
                 count(*) FILTER (WHERE p.is_marketable) AS marketable,
                 coalesce(avg(p.theo_12m), 0) AS "avgTheo",
                 coalesce(avg(p.non_gaming_paid_12m), 0) AS "avgNonGamingPaid"
          FROM cdp.segment s
          LEFT JOIN cdp.segment_member m USING (segment_code)
          LEFT JOIN cdp.player_profile p USING (account_number)
          GROUP BY s.segment_code, s.name, s.description, s.rule, s.sort_order
          ORDER BY s.sort_order`,
      ]);
      return {
        totals: totals!,
        channels: [...channels],
        segments: segments.map(({ email, sms, push, mail, ...s }) => ({ ...s, reach: { email, sms, push, mail } })),
      };
    },

    async sites() {
      const [sites, crossVisits] = await Promise.all([
        sql<(Omit<CdpSite, 'nonGaming'> & CdpSite['nonGaming'])[]>`
          WITH w AS (
              SELECT as_of_date AS to_date, as_of_date - 364 AS from_date
              FROM cdp.refresh_run WHERE finished_at IS NOT NULL ORDER BY run_id DESC LIMIT 1
          ),
          multi AS (
              SELECT account_number FROM cdp.player_site_summary GROUP BY 1 HAVING count(*) >= 2
          ),
          act AS (
              SELECT s.site_code, count(*) AS active, count(m.account_number) AS also_other,
                     sum(s.visit_days) AS visit_days, sum(s.trips) AS trips, sum(s.theo) AS theo,
                     sum(s.casino_win) AS casino_win, sum(s.comps_issued) AS comps
              FROM cdp.player_site_summary s LEFT JOIN multi m USING (account_number)
              GROUP BY 1
          ),
          home AS (
              SELECT home_site_code AS site_code, count(*) AS players
              FROM cdp.player_profile WHERE home_site_code IS NOT NULL GROUP BY 1
          ),
          ng AS (
              SELECT n.site_code,
                     coalesce(sum(n.paid_amount) FILTER (WHERE n.activity_type = 'hotel'), 0) AS hotel,
                     coalesce(sum(n.paid_amount) FILTER (WHERE n.activity_type = 'dining'), 0) AS dining,
                     coalesce(sum(n.paid_amount) FILTER (WHERE n.activity_type = 'retail'), 0) AS retail,
                     coalesce(sum(n.paid_amount) FILTER (WHERE n.activity_type = 'spa'), 0) AS spa,
                     coalesce(sum(n.paid_amount) FILTER (WHERE n.activity_type = 'golf'), 0) AS golf,
                     sum(n.paid_amount) AS paid,
                     coalesce(sum(n.paid_amount) FILTER (WHERE n.account_number IS NOT NULL), 0) AS known_paid
              FROM cdp.non_gaming_activity n, w
              WHERE n.status = 'completed' AND n.activity_date BETWEEN w.from_date AND w.to_date
              GROUP BY 1
          )
          SELECT s.site_code AS "siteCode", s.site_name AS name, s.city, s.property_id AS "propertyId",
                 f.is_mock AS "gamingIsMock",
                 coalesce(h.players, 0) AS "homePlayers",
                 coalesce(a.active, 0) AS "activePlayers", coalesce(a.also_other, 0) AS "alsoOtherSites",
                 coalesce(a.visit_days, 0) AS "visitDays", coalesce(a.trips, 0) AS trips,
                 coalesce(a.theo, 0) AS theo, coalesce(a.casino_win, 0) AS "casinoWin", coalesce(a.comps, 0) AS "compsIssued",
                 coalesce(n.hotel, 0) AS hotel, coalesce(n.dining, 0) AS dining, coalesce(n.retail, 0) AS retail,
                 coalesce(n.spa, 0) AS spa, coalesce(n.golf, 0) AS golf,
                 coalesce(n.paid, 0) AS "nonGamingPaid",
                 CASE WHEN n.paid > 0 THEN n.known_paid / n.paid END AS "knownGuestShare"
          FROM cdp.site s
          JOIN cdp.feed f ON f.feed_code = s.gaming_feed
          LEFT JOIN act a USING (site_code)
          LEFT JOIN home h USING (site_code)
          LEFT JOIN ng n USING (site_code)
          ORDER BY coalesce(a.theo, 0) + coalesce(n.paid, 0) DESC, s.site_code`,
        sql<CdpSitesData['crossVisits']>`
          SELECT p.home_site_code AS "homeSite", s.site_code AS "visitedSite", count(*) AS players
          FROM cdp.player_profile p
          JOIN cdp.player_site_summary s USING (account_number)
          WHERE p.home_site_code IS NOT NULL AND s.site_code <> p.home_site_code
          GROUP BY 1, 2
          ORDER BY 3 DESC`,
      ]);
      return {
        sites: sites.map(({ hotel, dining, retail, spa, golf, ...s }) => ({ ...s, nonGaming: { hotel, dining, retail, spa, golf } })),
        crossVisits: [...crossVisits],
      };
    },

    async examples(segment) {
      const [known] = await sql`SELECT 1 FROM cdp.segment WHERE segment_code = ${segment}`;
      if (!known) return null;
      const rows = await sql<CdpExample[]>`
        SELECT p.account_number::text AS "accountNumber", p.tier_name AS "tierName", p.home_site_code AS "homeSite",
               p.combined_value_12m AS "combinedValue"
        FROM cdp.segment_member m
        JOIN cdp.player_profile p USING (account_number)
        WHERE m.segment_code = ${segment}
        ORDER BY p.combined_value_12m DESC, p.account_number
        LIMIT 10`;
      return [...rows];
    },

    async player(accountNumber) {
      const [p] = await sql`
        SELECT *, signup_date::text AS signup, first_activity_date::text AS first_activity, last_activity_date::text AS last_activity
        FROM cdp.player_profile WHERE account_number = ${accountNumber}::numeric`;
      if (!p) return null;

      const [sites, recent, reach, segments, identifiers, hosts, [loyalty], [preferences]] = await Promise.all([
        sql<CdpPlayerSite[]>`
          SELECT site_code AS "siteCode", visit_days AS "visitDays", trips, gaming_days AS "gamingDays", theo,
                 casino_win AS "casinoWin", comps_issued AS "compsIssued", non_gaming_paid AS "nonGamingPaid",
                 non_gaming_comp AS "nonGamingComp", first_visit_date::text AS "firstVisit", last_visit_date::text AS "lastVisit"
          FROM cdp.player_site_summary WHERE account_number = ${accountNumber}::numeric
          ORDER BY visit_days DESC, theo DESC, site_code`,
        sql<(CdpActivity & { sortDate: string })[]>`
          SELECT * FROM (
              SELECT activity_date::text AS date, site_code AS "siteCode", 'gaming' AS kind,
                     string_agg(DISTINCT game_type, ' + ' ORDER BY game_type) || ' · ' || max(days_played) || ' day(s)' AS detail,
                     sum(theo) AS value, sum(comp_total) AS comp, 'completed' AS status, NULL AS "identityMethod",
                     bool_or(is_mock) AS "isMock", activity_date::text AS "sortDate"
              FROM cdp.gaming_activity
              WHERE account_number = ${accountNumber}::numeric AND (days_played > 0 OR theo > 0)
              GROUP BY activity_date, site_code
              UNION ALL
              SELECT activity_date::text, site_code, activity_type, coalesce(detail, ''), paid_amount,
                     comp_amount + points_amount, status, identity_method, is_mock, activity_date::text
              FROM cdp.non_gaming_activity
              WHERE account_number = ${accountNumber}::numeric
          ) a
          ORDER BY "sortDate" DESC, kind, "siteCode"
          LIMIT 30`,
        sql<(Omit<CdpPlayerReach, 'consentAt'> & { consentAt: Date | null })[]>`
          SELECT channel, is_reachable AS reachable, reason, has_contact AS "hasContact",
                 consent_status AS "consentStatus", consent_at AS "consentAt"
          FROM cdp.reachability WHERE account_number = ${accountNumber}::numeric
          ORDER BY array_position(${CDP_CHANNELS}::text[], channel)`,
        sql<{ code: string; name: string }[]>`
          SELECT m.segment_code AS code, s.name
          FROM cdp.segment_member m JOIN cdp.segment s USING (segment_code)
          WHERE m.account_number = ${accountNumber}::numeric
          ORDER BY s.sort_order`,
        sql<CdpPlayer['identifiers']>`
          SELECT identifier_type AS type, bool_or(is_verified) AS verified
          FROM cdp.identity_link WHERE account_number = ${accountNumber}::numeric
          GROUP BY 1 ORDER BY 1`,
        sql<CdpPlayerHost[]>`
          SELECT site_code AS "siteCode", rep_code AS "repCode", host_name AS name, is_permanent AS permanent,
                 next_arrival_date::text AS "nextArrival"
          FROM cdp.player_host WHERE account_number = ${accountNumber}::numeric
          ORDER BY is_permanent DESC, site_code, rep_code`,
        sql`
          SELECT member_since::text AS member_since, last_activity_date::text AS last_activity, lifetime_trips,
                 lifetime_casino_win, lifetime_comps, action_cash_earned, action_cash_used, tier_points,
                 tier_expires::text AS tier_expires, points_lifetime, points_year, points_year_label,
                 rewards_earned_lifetime, rewards_redeemed_lifetime, rewards_adjusted_lifetime, rewards_expired_lifetime,
                 rewards_earned_year, rewards_redeemed_year
          FROM cdp.player_loyalty WHERE account_number = ${accountNumber}::numeric`,
        sql<CdpPreferences[]>`
          SELECT top_game AS "topGame", top_game_share AS "topGameShare", top_denomination AS "topDenomination",
                 top_denomination_share AS "topDenominationShare", slot_ratings AS "slotRatings",
                 favorite_weekday AS "favoriteWeekday", weekday_share AS "weekdayShare",
                 favorite_daypart AS "favoriteDaypart", daypart_share AS "daypartShare"
          FROM cdp.player_preference WHERE account_number = ${accountNumber}::numeric`,
      ]);

      const num = (v: unknown): number => Number(v ?? 0);
      const nullable = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      return {
        accountNumber: String(p['account_number']),
        profile: {
          tierName: p['tier_name'],
          tierSource: p['tier_source'],
          residentialState: p['residential_state'],
          homeRegion: p['home_region'],
          signupDate: p['signup'],
          tenureDays: num(p['tenure_days']),
          isExcluded: p['is_excluded'],
          homeSite: p['home_site_code'],
          siteCodes: p['site_codes_12m'],
          firstActivity: p['first_activity'],
          lastActivity: p['last_activity'],
          recencyDays: nullable(p['recency_days']),
          visitDays: num(p['visit_days_12m']),
          trips: num(p['trips_12m']),
          gamingDays: num(p['gaming_days_12m']),
          theo: num(p['theo_12m']),
          adt: nullable(p['adt_12m']),
          casinoWin: num(p['casino_win_12m']),
          slotTheoShare: nullable(p['slot_theo_share']),
          compsIssued: num(p['comps_issued_12m']),
          reinvestmentRate: nullable(p['reinvestment_rate']),
          hotelStays: num(p['hotel_stays_12m']),
          hotelNights: num(p['hotel_nights_12m']),
          nonGaming: {
            hotel: num(p['hotel_paid_12m']),
            dining: num(p['dining_paid_12m']),
            retail: num(p['retail_paid_12m']),
            spa: num(p['spa_paid_12m']),
            golf: num(p['golf_paid_12m']),
          },
          nonGamingPaid: num(p['non_gaming_paid_12m']),
          nonGamingComp: num(p['non_gaming_comp_12m']),
          nonGamingShare: nullable(p['non_gaming_share']),
          combinedValue: num(p['combined_value_12m']),
          rfm:
            p['rfm_recency'] === null
              ? null
              : { recency: num(p['rfm_recency']), frequency: num(p['rfm_frequency']), monetary: num(p['rfm_monetary']) },
          app: {
            linked: p['app_user_id'] !== null,
            linkedAt: iso(p['app_linked_at']),
            activeDays90: num(p['app_active_days_90d']),
            lastActiveAt: iso(p['app_last_active_at']),
          },
          reachableChannels: p['reachable_channels'],
          hasMockData: p['has_mock_data'],
        },
        hosts: [...hosts],
        loyalty: loyalty
          ? {
              memberSince: loyalty['member_since'],
              lastActivity: loyalty['last_activity'],
              lifetimeTrips: nullable(loyalty['lifetime_trips']),
              lifetimeCasinoWin: nullable(loyalty['lifetime_casino_win']),
              lifetimeComps: nullable(loyalty['lifetime_comps']),
              actionCashEarned: nullable(loyalty['action_cash_earned']),
              actionCashUsed: nullable(loyalty['action_cash_used']),
              tierPoints: nullable(loyalty['tier_points']),
              tierExpires: loyalty['tier_expires'],
              keepTierPoints: nullable(p['keep_tier_points']),
              nextTier: p['next_tier_name'],
              nextTierPoints: nullable(p['next_tier_points']),
              pointsToNextTier: nullable(p['points_to_next_tier']),
              points: { lifetime: nullable(loyalty['points_lifetime']), year: nullable(loyalty['points_year']), yearLabel: loyalty['points_year_label'] },
              rewards: {
                earnedLifetime: nullable(loyalty['rewards_earned_lifetime']),
                redeemedLifetime: nullable(loyalty['rewards_redeemed_lifetime']),
                adjustedLifetime: nullable(loyalty['rewards_adjusted_lifetime']),
                expiredLifetime: nullable(loyalty['rewards_expired_lifetime']),
                earnedYear: nullable(loyalty['rewards_earned_year']),
                redeemedYear: nullable(loyalty['rewards_redeemed_year']),
              },
            }
          : null,
        preferences: preferences ?? null,
        sites: [...sites],
        recent: recent.map(({ sortDate: _sortDate, ...a }) => a),
        reach: reach.map((r) => ({ ...r, consentAt: iso(r.consentAt) })),
        segments: [...segments],
        identifiers: [...identifiers],
      };
    },
  };
}
