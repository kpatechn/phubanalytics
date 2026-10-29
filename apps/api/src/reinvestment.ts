import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import { ExecuteStatementCommand, type RDSDataClient } from '@aws-sdk/client-rds-data';
import type {
  RxAllocation,
  RxCampaign,
  RxCampaignDetail,
  RxConstraint,
  RxEvent,
  RxLift,
  RxMeta,
  RxOverview,
  RxPatron,
  RxPatronExample,
  RxRun,
  RxRunDetail,
  RxRunRequest,
} from '@phub/contracts';

// Reinvestment screens: every query reads the data platform's serving database (Aurora, schema
// serving) through the RDS Data API, for one tenant. Planning invokes the optimizer Lambda, which
// writes the plan to the lake and sends nothing. Patron IDs are the platform's pseudonymous IDs.

export interface RxRepo {
  meta(): Promise<RxMeta>;
  overview(): Promise<RxOverview>;
  /** Null for an unknown campaign. */
  campaign(campaignId: string): Promise<RxCampaignDetail | null>;
  patronExamples(): Promise<RxPatronExample[]>;
  /** Null for an unknown patron. */
  patron(patronId: string): Promise<RxPatron | null>;
  runs(): Promise<RxRun[]>;
  /** Null for an unknown run. */
  run(runId: string): Promise<RxRunDetail | null>;
  /** Throws PlanRefused when the optimizer refuses the request. */
  plan(request: RxRunRequest, requestedBy: string): Promise<RxRunDetail>;
}

export class PlanRefused extends Error {}

export interface ServingOptions {
  rds: RDSDataClient;
  lambda: LambdaClient;
  clusterArn: string;
  secretArn: string;
  database: string;
  tenant: string;
  optimizerFunction: string | undefined;
}

type Params = Record<string, string | number>;

const CAMPAIGN_COLUMNS = `
  campaign_id AS "campaignId", name, offer_type AS "offerType", face_value::float8 AS "faceValue",
  channel_rule AS "channelRule", audience_name AS "audienceName", audience_rule AS "audienceRule",
  holdout_share::float8 AS "holdoutShare", assigned_date::text AS "assignedDate", window_end::text AS "windowEnd",
  n_treatment::int AS "nTreatment", n_holdout::int AS "nHoldout", excluded_patrons::int AS "excludedPatrons",
  sent_rate::float8 AS "sentRate", delivered_rate::float8 AS "deliveredRate", opened_rate::float8 AS "openedRate",
  redeemed_rate::float8 AS "redeemedRate",
  visits_lift::float8 AS "visitsLift", visits_ci_low::float8 AS "visitsCiLow", visits_ci_high::float8 AS "visitsCiHigh",
  theo_lift::float8 AS "theoLift", theo_ci_low::float8 AS "theoCiLow", theo_ci_high::float8 AS "theoCiHigh",
  net_contribution_lift::float8 AS "netLift", net_contribution_ci_low::float8 AS "netCiLow",
  net_contribution_ci_high::float8 AS "netCiHigh", net_contribution_significant AS "netSignificant",
  net_incremental_profit::float8 AS "netIncrementalProfit", servicing_cost::float8 AS "servicingCost",
  underpowered, imbalanced, heavy_overlap AS "heavyOverlap", window_closed AS "windowClosed", verdict`;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function camelKeys<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) as T;
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A run as the optimizer reports it (lake row or Lambda response), in the screens' shape. */
function toRun(raw: Record<string, unknown>, fallbackParams?: RxRunRequest): RxRun {
  const params = parseJson<Record<string, unknown>>(raw['params'], {});
  const p = Object.keys(params).length ? params : {};
  const constraints = (Array.isArray(raw['constraints']) ? raw['constraints'] : parseJson<unknown[]>(raw['constraints'], []))
    .map((c) => camelKeys<RxConstraint>(c as Record<string, unknown>));
  const skipped = (Array.isArray(raw['skipped']) ? raw['skipped'] : parseJson<unknown[]>(raw['skipped'], []))
    .map((s) => camelKeys<RxRun['skipped'][number]>(s as Record<string, unknown>));
  const baseline = typeof raw['baseline'] === 'object' && raw['baseline'] !== null ? raw['baseline'] : parseJson(raw['baseline'], {});
  return {
    runId: String(raw['run_id'] ?? raw['runId']),
    createdAt: String(raw['created_at'] ?? raw['createdAt'] ?? new Date().toISOString()),
    status: String(raw['status']),
    requestedBy: (p['requested_by'] as string | undefined) ?? null,
    params: {
      budget: Number(p['budget'] ?? fallbackParams?.budget ?? raw['budget'] ?? 0),
      holdout: Number(p['holdout'] ?? fallbackParams?.holdout ?? 0.1),
      risk: (p['risk'] ?? fallbackParams?.risk ?? 'conservative') as RxRun['params']['risk'],
      caps: (p['site_caps'] ?? fallbackParams?.caps ?? {}) as Record<string, number>,
      floors: (p['site_floors'] ?? fallbackParams?.floors ?? {}) as Record<string, number>,
      maxOffers: (p['max_offers'] ?? fallbackParams?.maxOffers ?? null) as number | null,
    },
    spend: Number(raw['spend'] ?? 0),
    profit: Number(raw['profit'] ?? raw['expected_profit'] ?? 0),
    offers: Number(raw['offers'] ?? 0),
    holdoutPatrons: Number(raw['holdout_patrons'] ?? 0),
    baseline: baseline as RxRun['baseline'],
    constraints,
    skipped,
  };
}

export function createServingRepo(o: ServingOptions): RxRepo {
  async function query<T>(sql: string, params: Params = {}): Promise<T[]> {
    const out = await o.rds.send(
      new ExecuteStatementCommand({
        resourceArn: o.clusterArn,
        secretArn: o.secretArn,
        database: o.database,
        sql,
        formatRecordsAs: 'JSON',
        parameters: Object.entries({ tenant: o.tenant, ...params }).map(([name, value]) => ({
          name,
          value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value },
        })),
      }),
    );
    return JSON.parse(out.formattedRecords ?? '[]') as T[];
  }

  /** Reverse ETL creates the optimizer tables on its first copy; until a plan has run they don't exist. */
  async function optional<T>(sql: string, params: Params = {}): Promise<T[]> {
    try {
      return await query<T>(sql, params);
    } catch (e) {
      if (e instanceof Error && /SQLState: 42P01/.test(e.message)) return [];
      throw e;
    }
  }

  return {
    async meta() {
      const [[head], sites, [kind]] = await Promise.all([
        query<{ asOfMonth: string | null; ruleVersion: string | null }>(
          `SELECT max(month)::text AS "asOfMonth", max(rule_version) AS "ruleVersion" FROM serving.site_month WHERE tenant_id = :tenant`,
        ),
        query<{ siteId: string; name: string }>(
          `SELECT site_id AS "siteId", max(site_name) AS name FROM serving.site_month WHERE tenant_id = :tenant GROUP BY site_id ORDER BY site_id`,
        ),
        query<{ dataKind: string | null }>(`SELECT max(data_kind) AS "dataKind" FROM serving.feed_status WHERE tenant_id = :tenant`),
      ]);
      return {
        tenant: o.tenant,
        dataKind: kind?.dataKind === 'real' ? 'real' : 'mock',
        asOfMonth: head?.asOfMonth ?? null,
        ruleVersion: head?.ruleVersion ?? null,
        sites,
        optimizerEnabled: Boolean(o.optimizerFunction),
      };
    },

    async overview() {
      const [months, campaigns] = await Promise.all([
        query<RxOverview['months'][number]>(`
          SELECT site_id AS "siteId", site_name AS "siteName", month::text AS month, patrons::int, visits::int,
                 theo::float8, casino_win::float8 AS "casinoWin", freeplay_redeemed::float8 AS "freeplayRedeemed",
                 comps_issued::float8 AS "compsIssued", reinvestment::float8, incentive_cost::float8 AS "incentiveCost",
                 hospitality_paid::float8 AS "hospitalityPaid", net_contribution::float8 AS "netContribution"
          FROM serving.site_month
          WHERE tenant_id = :tenant
            AND month > (SELECT max(month) FROM serving.site_month WHERE tenant_id = :tenant) - interval '12 months'
          ORDER BY month, site_id`),
        query<RxCampaign>(`SELECT ${CAMPAIGN_COLUMNS} FROM serving.campaign_summary WHERE tenant_id = :tenant ORDER BY assigned_date DESC`),
      ]);
      return { months, campaigns };
    },

    async campaign(campaignId) {
      const [campaign] = await query<RxCampaign>(
        `SELECT ${CAMPAIGN_COLUMNS} FROM serving.campaign_summary WHERE tenant_id = :tenant AND campaign_id = :id`,
        { id: campaignId },
      );
      if (!campaign) return null;
      const lift = await query<RxLift>(
        `SELECT segment, metric, n_treatment::int AS "nTreatment", n_holdout::int AS "nHoldout",
                mean_treatment::float8 AS "meanTreatment", mean_holdout::float8 AS "meanHoldout",
                adjusted_diff::float8 AS "adjustedDiff", adjusted_ci_low::float8 AS "adjustedCiLow",
                adjusted_ci_high::float8 AS "adjustedCiHigh", significant,
                min_detectable_effect::float8 AS "minDetectableEffect", pre_period_smd::float8 AS "prePeriodSmd", underpowered
         FROM serving.campaign_lift WHERE tenant_id = :tenant AND campaign_id = :id
         ORDER BY metric, array_position(ARRAY['all', 'low', 'mid', 'high'], segment)`,
        { id: campaignId },
      );
      return { campaign, lift };
    },

    async patronExamples() {
      return query<RxPatronExample>(`
        WITH redeemers AS (
          SELECT patron_id, count(*) AS n FROM serving.patron_journey
          WHERE tenant_id = :tenant AND event_type = 'redeemed' GROUP BY patron_id
        )
        (SELECT p.patron_id AS "patronId", p.tier_name AS "tierName", p.home_property_id AS "homePropertyId",
                p.net_contribution_12m::float8 AS "netContribution12m", 'redeemed ' || r.n || ' offer(s)' AS note
         FROM redeemers r JOIN serving.patron_profile p ON p.tenant_id = :tenant AND p.patron_id = r.patron_id
         ORDER BY p.net_contribution_12m DESC LIMIT 4)
        UNION ALL
        (SELECT patron_id, tier_name, home_property_id, net_contribution_12m::float8, 'top value, ' || sites_visited_12m || ' site(s)'
         FROM serving.patron_profile WHERE tenant_id = :tenant AND sites_visited_12m >= 3
         ORDER BY net_contribution_12m DESC LIMIT 3)
        UNION ALL
        (SELECT patron_id, tier_name, home_property_id, net_contribution_12m::float8, 'restricted: no offers'
         FROM serving.patron_profile WHERE tenant_id = :tenant AND suppress_offers AND visits_12m > 0
         ORDER BY net_contribution_12m DESC LIMIT 1)`);
    },

    async patron(patronId) {
      const [profile] = await query<Omit<RxPatron, 'reach' | 'journey'>>(
        `SELECT patron_id AS "patronId", as_of_date::text AS "asOfDate", tier_name AS "tierName", tier_points::float8 AS "tierPoints",
                next_tier_name AS "nextTierName", points_to_next_tier::float8 AS "pointsToNextTier",
                home_property_id AS "homePropertyId", sites_visited_12m::int AS "sitesVisited12m", visits_12m::int AS "visits12m",
                theo_12m::float8 AS "theo12m", adt_12m::float8 AS "adt12m", casino_win_12m::float8 AS "casinoWin12m",
                reinvestment_12m::float8 AS "reinvestment12m", reinvestment_rate::float8 AS "reinvestmentRate",
                hospitality_paid_12m::float8 AS "hospitalityPaid12m", net_contribution_12m::float8 AS "netContribution12m",
                recency_days::int AS "recencyDays", suppress_offers AS "suppressOffers"
         FROM serving.patron_profile WHERE tenant_id = :tenant AND patron_id = :id`,
        { id: patronId },
      );
      if (!profile) return null;
      const [reach, journey] = await Promise.all([
        query<RxPatron['reach'][number]>(
          `SELECT channel, reason FROM serving.reachability WHERE tenant_id = :tenant AND patron_id = :id ORDER BY channel`,
          { id: patronId },
        ),
        query<RxEvent>(
          `SELECT to_char(event_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "eventAt", event_type AS "eventType", site_id AS "siteId",
                  campaign_id AS "campaignId", channel, amount::float8 AS amount, detail
           FROM serving.patron_journey WHERE tenant_id = :tenant AND patron_id = :id
           ORDER BY event_at DESC LIMIT 400`,
          { id: patronId },
        ),
      ]);
      return { ...profile, reach, journey };
    },

    async runs() {
      const rows = await optional<Record<string, unknown>>(
        `SELECT run_id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, status, params, spend::float8 AS spend,
                profit::float8 AS profit, offers::int AS offers, holdout_patrons::int AS holdout_patrons, baseline, constraints, skipped
         FROM serving.optimizer_run WHERE tenant_id = :tenant ORDER BY created_at DESC LIMIT 25`,
      );
      return rows.map((r) => toRun(r));
    },

    async run(runId) {
      const [row] = await optional<Record<string, unknown>>(
        `SELECT run_id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, status, params, spend::float8 AS spend,
                profit::float8 AS profit, offers::int AS offers, holdout_patrons::int AS holdout_patrons, baseline, constraints, skipped
         FROM serving.optimizer_run WHERE tenant_id = :tenant AND run_id = :id`,
        { id: runId },
      );
      if (!row) return null;
      const allocation = await query<RxAllocation>(
        `SELECT template_id AS "templateId", segment, site_id AS "siteId", eligible::int, offers::int,
                value_per_offer::float8 AS "valuePerOffer", cost_per_offer::float8 AS "costPerOffer", spend::float8, profit::float8,
                response_source AS "responseSource", reason
         FROM serving.optimizer_allocation WHERE tenant_id = :tenant AND run_id = :id
         ORDER BY profit DESC, template_id, segment, site_id`,
        { id: runId },
      );
      return { run: toRun(row), allocation };
    },

    async plan(request, requestedBy) {
      if (!o.optimizerFunction) throw new PlanRefused('The optimizer is not configured on this server.');
      const payload = {
        tenant: o.tenant,
        budget: request.budget,
        holdout: request.holdout ?? 0.1,
        risk: request.risk ?? 'conservative',
        caps: request.caps ?? {},
        floors: request.floors ?? {},
        ...(request.maxOffers ? { max_offers: request.maxOffers } : {}),
        requested_by: requestedBy,
      };
      const out = await o.lambda.send(
        new InvokeCommand({ FunctionName: o.optimizerFunction, Payload: new TextEncoder().encode(JSON.stringify(payload)) }),
      );
      const body = JSON.parse(new TextDecoder().decode(out.Payload ?? new Uint8Array())) as Record<string, unknown>;
      if (out.FunctionError) throw new Error(`optimizer failed: ${String(body['errorMessage'] ?? out.FunctionError)}`);
      if (typeof body['error'] === 'string') throw new PlanRefused(body['error']);
      const allocation = ((body['allocation'] as Record<string, unknown>[] | undefined) ?? []).map((a) => camelKeys<RxAllocation>(a));
      return {
        run: { ...toRun(body, request), requestedBy, createdAt: new Date().toISOString() },
        allocation: allocation.sort((a, b) => b.profit - a.profit),
      };
    },
  };
}
