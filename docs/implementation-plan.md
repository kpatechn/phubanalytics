# PlayerHub App Analytics: Phased Implementation Plan

Handoff for Claude Code. Compiled 2026-10-22 from the dashboard work done in chat (v1 to v5 prototypes, Angular implementation guide, tracking spec). Start with the data we already have (the Graton dev analytics log) and build outward.

---

## 0. How to use this file

- Work phase by phase. Each phase has deliverables and acceptance criteria. Do not start a phase before its dependencies pass.
- The golden fixture (Phase 1) is the source of truth. Every query and every UI number must reproduce the values in section 4.
- Never commit the raw export `mob-analytics-log.xlsx`. It contains live session IDs. Commit only the scrubbed fixture.
- The public repo `kpatechn/playerhub-insights` (GitHub Pages demo) must contain SAMPLE-property data only. No Graton data goes there.

## 1. Context

PlayerHub (B2B SaaS, white-label mobile apps for tribal and commercial casinos) wants app analytics for three audiences:

| Audience | Question | Primary metrics |
|---|---|---|
| Executive | Are guests adopting the app, and what is at risk? | Sessions, login success, on-property share, feature usage, API failures |
| Marketing | Are messages and offers reaching guests and getting acted on? | Message funnel, push opens by campaign, opt-in/denial, geofence entries, partner web content |
| IT and Operations | What is failing, where, and is telemetry healthy? | Errors by endpoint/status, error trend, push delivery, biometric pass rate, upload failures |

Stack (decided): Angular 21 (standalone, signals, zoneless, Vitest), Node 24 + Fastify 5 + TypeScript, PostgreSQL 16+, plain SQL via postgres.js (no ORM), Apache ECharts (called directly through one directive), zod validation, npm workspaces monorepo.

Dashboard iterations built so far (prototypes, all static HTML):
- v1: 3-tab exec/marketing/IT dashboard from the real log.
- v2: weekly briefing format, real vs illustrative data labeled.
- v3: sales demo for fictional "Sample Resort & Casino" with ROI calculator (net gaming revenue, hotel commission avoided, operating costs avoided).
- v4: 8 sections (Value, Guests, Business lines, Marketing, Efficiency, Responsible gaming, Reliability, Data and method), property switcher between measured Graton and sample data.
- v5: 80 metrics, each with an info icon (calculation, data source, why it matters, how to use it), P1-P3 priority indicators for missing data, value x effort matrix, searchable metric directory, casino-terms glossary (tribal and commercial wording), sample-property data only. Files: index.html, metrics.js, README.md, METRICS.md. Provided as a zip for manual upload.

Principles the owner (KP) cares about:
- Additive development. Do not drop features from earlier versions (v4 lost IT diagnostics, on/off-property splits and message funnels from v1, and week-over-week, peer benchmarks and the raw-vs-matched trip gap from v2/v3. Carry everything forward).
- Every sample or invented number is visibly labeled as such. Never mix real and sample data in one view.
- Defensible ROI methodology: subtract reinvestment/comps from gross figures, and credit campaigns only through holdout-group comparison, never raw lift.

## 2. The data we have

File: `mob-analytics-log.xlsx`, 3,494 events, 2026-09-03 to 2026-10-02, dev environment (every API call goes to `playerhub-dev.graton.com`), 13 test accounts. Treat results as instrumentation and app-health checks, not guest behavior.

Columns: `Created Date` (format `MM-DD-YYYY hh:mm AM/PM`, Pacific time), `Event Name`, `Location Context` (`onsite`/`offsite`), `Payload`, `Old Value`, `New Value`, `Attributes` (JSON string).

Attribute keys seen: `player_id`, `endpoint`, `method`, `status_code`, `error_type`, `error_message`, `url`, `screen_name`, `auth_method`, `login_method`, `geofence_name`, `title`, `time_spent_ms`, `is_cta_completed`, `campaign_id`, `platform`, `provider`, `status`, `denial_type`, `action`, `is_account_delete`.

Time zone: `Created Date` is Pacific (03:25 PM shown = 22:25 UTC in the attribute timestamp). Store UTC. Group by day in `America/Los_Angeles` for Graton.

Feature map (seed `analytics_feature_map`):

| Feature | Event names |
|---|---|
| Wallet | Cashless Wallet screen opened; Wallet balance refreshed |
| Fast Funds | Fast Funds screen/WebView opened |
| Inbox | Inbox list viewed |
| Live Drawing | Live drawing screen opened |
| Promotions | Promotions screen viewed; Promotion details viewed (with timeline); Offers list rendered |
| Events | Events list page opened; Event details page opened (with timeline) |
| Gaming | Gaming hub screen viewed; Table games main screen viewed; Slots screen viewed; Live poker screen viewed |
| Dining & Resort | Restaurants list viewed; Property Info screen viewed; Resort pool screen viewed |
| Card linking | Link flow started |
| Tier status | tier_status_viewed |
| Tax report | Win/loss tax report sent |

Other key events: `session_started`, `app_opened`, `Login process started`, `Login success`, `User logged out`, `api_error`, `page_open`, `Notification detail opened`, `Notification marked read`, `Notification deleted`, `Player opened push notification`, `Platform/device handling outcome` (`received_foreground`), `notification_permission_granted/denied`, `location_permission_granted`, `bluetooth_permission_granted`, `geofence_entered/exited`, `webview_viewed`, `FaceID/TouchID passed/failed`, `Generic button tap`, `User triggered pull to refresh on a screen`.

## 3. Findings already established (use as acceptance data)

- Login success 95% (55 of 58). 13 distinct accounts. OTP is the main auth method.
- 54% of events onsite (1,877 of 3,494). Wallet about 70% offsite, card-link starts about 74% offsite.
- 438 API errors. 227 on `account/analyticLogs` (197 HTTP 400, 12 HTTP 500 with .NET `System.Text.Json.JsonElement` cast error, rest connection errors/timeouts). 159 HTTP 500 on `dexy/graton/points` (message TLGY01). 33 host-lookup failures.
- Marketing: 16 of 16 push opens have `campaign_id = unknown_campaign`. 38 messages opened, 38 read, 76 deleted, 0 CTA completed (`is_cta_completed` false everywhere, probably a tracking gap). 20 notification denials: 18 skipped, 2 permanent. `notification_permission_granted` fires 204 times (on app launches), so no opt-in rate can be computed from it.
- Gift & Go web content averages 0.5 s (load failure or bounce).
- Geofence: 327 entries, 9 exits. Test zones include "Aaraverse office" and "KP'Geo Location".
- Biometric: 21 pass, 2 fail.

## 4. Golden fixture checks (must pass in Phase 1)

| Check | Expected |
|---|---|
| Total events | 3,494 |
| Sessions started | 186 |
| App opens | 230 |
| Login attempts / successes | 58 / 55 |
| Distinct accounts logged in | 13 |
| On-property events | 1,877 |
| API errors | 438 |
| Errors on analyticLogs / points | 227 / 159 |
| Inbox views / opened / read / deleted | 84 / 38 / 38 / 76 |
| Push opens / foreground receipts | 16 / 20 |
| Geofence entries / exits | 327 / 9 |
| Biometric passed / failed | 21 / 2 |

## 5. Data model (PostgreSQL 16+)

```sql
CREATE TABLE analytics_event (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  created_at       timestamptz NOT NULL,            -- client event time, UTC
  received_at      timestamptz NOT NULL DEFAULT now(),
  environment      text NOT NULL CHECK (environment IN ('prod','staging','dev')),
  event_name       text NOT NULL,
  location_context text CHECK (location_context IN ('onsite','offsite')),
  client_event_id  uuid NOT NULL,                   -- device-generated, dedupe key
  player_id        text,
  device_id        text,
  session_id       text,
  platform         text,                            -- 'ios' | 'android'
  app_version      text,
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, created_at),
  UNIQUE (client_event_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE analytics_event_2026_10 PARTITION OF analytics_event
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE INDEX ON analytics_event (environment, event_name, created_at);
CREATE INDEX ON analytics_event USING brin (created_at);
CREATE INDEX ON analytics_event ((attributes->>'endpoint'), created_at) WHERE event_name = 'api_error';
CREATE INDEX ON analytics_event (player_id, created_at) WHERE player_id IS NOT NULL;

CREATE TABLE analytics_feature_map (event_name text PRIMARY KEY, feature text NOT NULL);

CREATE TABLE analytics_daily (
  day date NOT NULL, environment text NOT NULL, event_name text NOT NULL,
  location_context text NOT NULL DEFAULT 'unknown', event_count bigint NOT NULL,
  PRIMARY KEY (day, environment, event_name, location_context));

CREATE TABLE analytics_error_daily (
  day date NOT NULL, environment text NOT NULL, endpoint text NOT NULL, method text NOT NULL,
  status_code text NOT NULL, error_type text NOT NULL, error_count bigint NOT NULL,
  PRIMARY KEY (day, environment, endpoint, method, status_code, error_type));
```

Notes:
- Partition key must be in every unique constraint (hence `created_at` in PK and dedupe key). Create next month's partition at least 7 days ahead (pg_partman or a job). Alert if missing. Retention 13 months (drop partitions only after rollups exist). Rollups (no identifiers) kept longer.
- DECISION NEEDED BEFORE CREATING TABLES: multi-property. PlayerHub serves several casinos. If one deployment holds more than one, add `property_id text NOT NULL` to the event table, both rollups, every index, every query filter, an API `property` parameter, and a UI selector. Cheap now, expensive later. Default recommendation: add it now.

## 6. Ingestion contract

`POST /mobile/v2/account/analyticLogs` (path unchanged), body:

```json
{
  "device": { "deviceId": "a1b2", "platform": "android", "appVersion": "3.4.1" },
  "sessionId": "7f3c0e52",
  "events": [{
    "clientEventId": "0b6c6f6e-6f0e-4a54-9a0a-1d2f6c5a7d11",
    "eventName": "Login success",
    "createdAt": "2026-10-02T22:21:56.829Z",
    "locationContext": "offsite",
    "attributes": { "auth_method": "otp" }
  }]
}
```

Rules:
- Server takes `player_id` from the authenticated token and environment from deployment config. Ignore client-supplied values.
- Batch up to 200 events. Validate each event with `safeParse` so one bad event becomes a `rejected` entry, not a failed batch. Return `202 { accepted, duplicates, rejected: [{index, reason}] }`. Return 400 only for a malformed envelope.
- Reject `createdAt` more than 24 h in the future or older than 30 days. Body cap 1 MB, attributes 8 KB per event, nesting depth 5. Rate limit per device (about 60 req/min, `@fastify/rate-limit`). Never log request bodies.
- Scrub before insert: delete `sessionId`, `token`, `access_token`, `auth`, `password` query params from any `attributes.url`; truncate `error_message` to 500 chars. (`webview_viewed` URLs in the sample contain live `sessionId` and `playerId`. Purge any stored rows and treat the spreadsheet as sensitive.)
- Insert: one multi-row insert with `ON CONFLICT (client_event_id, created_at) DO NOTHING RETURNING 1`. Duplicates = rows minus returned.

zod sketch:

```ts
const EventSchema = z.object({
  clientEventId: z.uuid(), eventName: z.string().min(1).max(120), createdAt: z.iso.datetime(),
  locationContext: z.enum(['onsite','offsite']).nullish(), attributes: z.record(z.string(), z.unknown()).default({}),
});
export const BatchSchema = z.object({
  device: z.object({ deviceId: z.string().max(64), platform: z.enum(['ios','android']), appVersion: z.string().max(32) }),
  sessionId: z.string().max(64).optional(),
  events: z.array(z.unknown()).min(1).max(200),
});
```

Where ingestion lives is an open question: the `analyticLogs` errors include .NET messages, so the endpoint probably sits in an existing .NET service. Either implement this contract there and write to this Postgres, or keep it as a thin forwarder to the Node ingest route. Capture a few rejected payloads first to diagnose the 197 HTTP 400s.

## 7. Summary API

Three read-only endpoints, one envelope. Query params: `from`, `to` (YYYY-MM-DD, business time zone, inclusive), `env` (`prod|staging|dev`, default `prod`), plus `property` if multi-property. Defaults: last 30 days. Max range 92 days. Invalid input gives `400 application/problem+json`. Time zone is server config, not a client param.

| Endpoint | Role | Returns |
|---|---|---|
| `GET /api/analytics/executive` | `analytics:exec` | KPIs, daily series, feature usage |
| `GET /api/analytics/marketing` | `analytics:marketing` | Message funnel, campaigns, permissions, geofences, web content |
| `GET /api/analytics/it` | `analytics:it` | Errors, hourly activity, screens, biometrics, push delivery |

`analytics:admin` passes every check. 401 for missing/invalid token, 403 for wrong role.

Contract types (shared package `packages/contracts`):

```ts
export interface Meta { from: string; to: string; environment: 'prod'|'staging'|'dev'; timeZone: string; generatedAt: string; source: 'raw'|'rollup'; }
export interface Envelope<T> { meta: Meta; data: T }
export interface DailyPoint { day: string; sessions: number; logins: number; errors: number; events: number }
export interface FeatureUsage { feature: string; onsite: number; offsite: number }
export interface ExecutiveData {
  kpis: { sessions: number; appOpens: number; loginStarted: number; loginSuccess: number; playersLoggedIn: number; onsiteEvents: number; apiErrors: number; totalEvents: number };
  daily: DailyPoint[]; features: FeatureUsage[];
}
export interface MarketingData {
  funnel: { inboxViewed: number; opened: number; markedRead: number; ctaCompleted: number; deleted: number; pushOpened: number; pushReceived: number };
  campaigns: { campaignId: string; opens: number }[]; topMessages: { title: string; opens: number }[];
  permissions: { granted: number; denied: number; denialTypes: { type: string; count: number }[] };
  geofences: { zone: string; entries: number }[]; geofenceExits: number;
  webContent: { page: string; opens: number; avgSeconds: number | null }[]; contentViews: { label: string; views: number }[];
}
export interface ItData {
  errors: { endpoint: string; method: string; statusCode: string; errorType: string; count: number }[];
  topMessages: { message: string; count: number }[]; daily: DailyPoint[]; hourly: { hour: number; events: number }[];
  screens: { screen: string; opens: number }[]; biometrics: { passed: number; failed: number }; pushReceived: number;
}
```

Query pattern: every query takes `$1` start (timestamptz), `$2` end exclusive, `$3` environment, `$4` IANA tz. Use `count(*) FILTER (WHERE event_name = ...)` for KPI rows; zero-filled daily series via `generate_series` LEFT JOIN; feature usage via JOIN to `analytics_feature_map` grouped by feature split on `location_context`; marketing and IT queries are `GROUP BY attributes->>'<key>'` on the relevant event name (campaign_id, title, denial_type, geofence_name, webview title + avg `time_spent_ms`/1000, endpoint/method/status_code/error_type, first line of `error_message`, hour via `extract(hour FROM created_at AT TIME ZONE $4)`, `screen_name` for `page_open`).

Range helper: convert local days to UTC bounds in Postgres: `(${from}::date)::timestamp AT TIME ZONE ${tz}` and `((${to}::date + 1))::timestamp AT TIME ZONE ${tz}`.

Other API rules: register a postgres.js parser turning bigint into number. Cache 60 s in memory keyed by view+range+env; `Cache-Control: private, max-age=60` plus ETag (ranges ending before today may use max-age=300). Read-only DB role with `statement_timeout = '10s'`. Separate write role used only by ingest and jobs. Distinct counts always come from the raw table (not additive across days), capped at 92 days. Ranges of 31 days or less use raw table; longer ranges use rollups for counts.

Rollup job: every 15 minutes, recompute the last two local days (late events), upsert into `analytics_daily` and `analytics_error_daily`. Guard with `pg_try_advisory_lock`. Partition job daily.

Env vars (validate at startup, exit if missing): `DATABASE_URL` (read-only), `INGEST_DATABASE_URL` (write), `APP_ENVIRONMENT`, `BUSINESS_TIME_ZONE`, `JWT_JWKS_URL`, `ALLOWED_ORIGIN` (only if cross-origin).

## 8. Angular 21 app

Structure: `core/` (auth interceptor, role guard, problem type), `analytics/` (api service, filters, insights.ts, shell, executive/marketing/it-ops pages), `shared/` (kpi-tile, bar-list, insight-callout, chart directive, chart-theme, skeleton, error panel), `styles/tokens.scss`.

Decisions:
- Standalone components, signals, `inject()`, `input()`, `computed()`, `@if/@for`, OnPush. No NgModules, no `*ngIf`. TypeScript strict + `noUncheckedIndexedAccess`.
- Filters (range preset, custom range, env, property) live in one injectable of signals, mirrored to the URL query string. No player IDs in URLs. Visible banner whenever env is not `prod`.
- One `load<T>(view)` helper returns a signal of `loading | error | ready`, uses `switchMap` to cancel the previous request. Pages call it once from a field initializer.
- Lazy-loaded routes with `canMatch` role guards (convenience only, server enforces).
- ECharts: register only LineChart, BarChart, Grid, Tooltip, Legend, Aria, CanvasRenderer. One `[appChart]` directive with ResizeObserver. Chart colors read from CSS tokens, refresh on color-scheme change. Respect `prefers-reduced-motion`.
- Insight rules are pure functions in `insights.ts` with config-driven thresholds and minimum sample sizes (login rate needs 20 or more attempts, wallet off-property flag needs 30 or more events at 60% or higher, upload-failure flag needs 20 or more errors at 10% or higher, fix-first flag for the worst 5xx endpoint at 10 or more). Marketing rules: unknown campaign above 20%, deletes greater than reads, denials mostly skipped.
- Design tokens: `--bg --surface --ink --ink2 --mute --line --grid --accent(teal) --ctx(grey) --good --warn --bad` plus soft backgrounds, light and dark (`prefers-color-scheme` guarded by `:root:not([data-theme="light"])`, plus `[data-theme="dark"]`). Teal = magnitude, grey = context, status colors only for status. Never rely on color alone: icon + text.
- Accessibility: real `routerLink` tabs, chart aria-labels, "View as table" toggle, 4.5:1 contrast, axe in CI for both themes.
- Mock JSON shaped like the contract lets this phase run before the backend.
- Open: which Angular UI library (Material, PrimeNG, internal) decides shell/tabs/date picker and token mapping.

Metric dictionary: every tile gets a tooltip definition (event source, formula, caveat). Key caveats: counts are events not guests; retries count as extra login attempts; hide biometric rate below 20 events; foreground push receipts are a floor; never compute opt-in from `notification_permission_granted`; points errors count calls not guests; map geofence IDs to display names and exclude test zones.

## 9. Security and privacy

- Aggregates only in the UI. The event table is sensitive (player IDs).
- Roles: `analytics:exec`, `analytics:marketing`, `analytics:it`, `analytics:admin`. Enforced on server per request.
- Tokens not in localStorage (HttpOnly cookie via BFF or in memory). Strict CSP (`default-src 'self'`), TLS only.
- Deletion: use the app's `User logged out` event with `is_account_delete`; a job deletes that player's raw events (uses the `player_id` index). Confirm retention (13 months) and deletion rules with Graton privacy/compliance before launch. Not legal advice.
- No guest-level screens in v1. Add later behind a separate role with an access log.

## 10. Phased delivery plan

Sizes are relative (S, M, L). No dates assumed. Two tracks run in parallel: Track A (platform, starts now with data in hand) and Track B (mobile telemetry fixes, owned by the app team).

### Phase 1: Data foundation from the log we have (Track A, M, no dependencies)
Deliverables:
- Monorepo scaffold (`apps/api`, `apps/web`, `packages/contracts`, `db/migrations`, `fixtures`), Node 24, CI skeleton.
- Decide and apply the multi-property question (section 5).
- Migrations for all tables, first partitions, indexes, feature map seed.
- One-off script: `mob-analytics-log.xlsx` to `fixtures/sample-events.json` (Pacific to UTC, generate `clientEventId`, run every row through `scrub()`, drop the raw file from git).
- Ingest route (contract in section 6), rollup job, partition job.
Acceptance: Testcontainers (`postgres:17`) golden test reproduces every value in section 4. Rollup is idempotent (run twice, same counts) and picks up a late event. Time-zone test around a DST change (23:30 and 00:30 Pacific). Ingest test: one invalid event, one duplicate, one future timestamp, and a `sessionId` query param never reaches the table.

### Phase 2: Summary API (Track A, M, needs Phase 1)
Deliverables: three endpoints, auth and roles, cache, `contracts` package, problem responses.
Acceptance: contract and authorization tests (no token 401, wrong role 403, right role 200). p95 under 800 ms for 30-day (raw) and 92-day (rollup) on staging-sized data.

### Phase 3: Angular shell and Executive page (Track A, M, needs contract only)
Deliverables: project, shell, filters, API service, shared components, theme, loading/error states, Executive page against mock JSON from the fixture, switching to the real API after Phase 2.
Acceptance: matches prototype v1 numbers on the fixture. axe passes in light and dark. Works at 400 px width. Initial JS budget 300 KB gzip or less.

### Phase 4: Marketing and IT pages (Track A, M, needs Phase 3)
Deliverables: both pages, tables, insight rules (unit tested, thresholds in config), "View as table" toggle, tooltips from the metric dictionary.
Acceptance: each page renders from recorded API responses. Insight tests cover below-minimum-sample, at-threshold and above-threshold.

### Phase 5: Telemetry fixes in the mobile app (Track B, M, parallel from day one)
Deliverables:
- Batched upload with `clientEventId`, on-device queue, exponential backoff, keep queue until 202.
- `deviceId`, `platform`, `appVersion` once per batch; stable `player_id` or device ID on every event (one ID format, today IDs are mixed numeric and UUID); `locationContext` on every event.
- Real `campaign_id` in the push payload and on push-open events.
- Set `is_cta_completed` when the guest taps the action.
- Log permission state changes only (or add a `first_prompt` flag).
- No session IDs in logged URLs.
- Publish an event catalog and one naming convention.
Acceptance: upload failures under 1% over 24 h of staging traffic. No `sessionId` in any stored URL. Campaign IDs populated on push opens.

Phase 5 is what lets the dashboards stop undercounting (today 52% of logged API errors are the analytics upload failing).

### Phase 6: Advanced metrics layer from the v5 spec (Track A, L, needs Phases 4 and 5)
Deliverables:
- Metric registry (the 80-metric catalog from v5 `metrics.js`: calculation, source, importance, how to use) driving info icons in Angular.
- P1-P3 priority indicators for metrics whose data is not yet captured (business-value-first, value x effort matrix).
- Add the sections that v4 dropped and v5 restored: IT diagnostics, on/off-property feature splits, message funnels, week-over-week, peer benchmarks, raw-vs-matched trip gap explanation.
- Value/ROI view with editable cost assumptions: subtract reinvestment/comps, credit campaigns only through holdout comparison.
- Responsible gaming as its own visible section. Casino terminology switch (tribal and commercial wording, glossary).
Acceptance: every metric shows the info panel. Missing-data metrics show their priority. No real data appears in sample mode.

### Phase 7: Hardening (M, needs Phases 2 and 4)
Deliverables: pino structured logs, `/healthz` and `/readyz` (DB reachable, latest rollup under 30 min), metrics (accepted/rejected/duplicate per minute, ingest latency, query latency per view, rollup lag), alerts (rejection above 5% for 10 min, rollup lag above 30 min, summary p95 above 2 s, no prod events for 1 h), "Data as of" banner when newest prod event is over an hour old, load test, security review, retention and deletion jobs, runbook, quarterly restore test.
Acceptance: alerts fire in a staging drill. Deletion job removes a test player's events. Review findings closed.

### Phase 8: Launch (S, needs Phase 7)
Deliverables: one-week staging soak on production-like traffic, role assignment, walkthrough for executives, marketing and IT, exclude staff/test accounts from production numbers.
Acceptance: no open severity 1 or 2 defects. Each audience signs off its own view.

v1.1 follow-ups: CSV export per view, saved date ranges, week-over-week on every KPI, alerting on insight rules, guest-level drill-down behind a separate role once player identity is reliable.

## 11. Open questions (resolve before Phase 1 unless noted)

1. Multiple properties: add `property_id` now? (recommended yes)
2. Where ingestion lives: existing .NET service vs Node route. Capture sample rejected payloads.
3. Angular UI library in use.
4. Identity provider for staff tokens and whether it can carry the three roles as claims.
5. Are events already in Postgres? If yes, plan a one-time backfill with scrubbing and `clientEventId` generation.
6. Time zone per property (Graton is `America/Los_Angeles`).
7. Retention: confirm 13 months with compliance.
8. Who owns insight thresholds (95% login success, 10% upload failures, 60% off-property wallet). Keep in config.
9. How test/staff accounts are identified in production.

## 12. Known data issues (from the sample log)

| Issue | Evidence | Effect | Fix |
|---|---|---|---|
| Analytics uploads fail | 227 errors on analyticLogs | Events lost, all metrics undercount | Accept partial batches, queue and retry |
| Push opens lack campaign | 16 of 16 unknown_campaign | No per-campaign results | Pass real campaign ID |
| CTA never set | is_cta_completed false on 38 of 38 | CTA rate always 0% | Verify app sets it |
| Session ID in URLs | webview_viewed carries sessionId and playerId | Credential exposure | Strip at ingestion and in app |
| Permission events repeat | 204 granted vs 20 denied | Opt-in rate would be wrong | Log state changes only |
| Sparse/mixed player IDs | Only some events carry player_id; numeric or UUID | Distinct-guest counts unreliable | One ID on every event |
| Inconsistent event names | session_started vs Login success | Fragile queries | Event catalog, one convention |
| Dev/test data | dev API, test geofences | Rates not real | Filter by env, exclude test accounts |

## 13. Reference material not included here

- Claude doc "PlayerHub App Analytics Dashboard: Implementation Guide" (full code samples, architecture diagram). Essentials are reproduced above.
- v5 prototype zip (index.html, metrics.js, README.md, METRICS.md). Needed for Phase 6; add it to the repo under `prototype/`.
- Related but separate threads: the broader PlayerHub analytics platform architecture (hybrid deployment, cohort/crosswalk design, Athena-over-Parquet Phase 1) and the Snowflake mock-data POC. This plan uses Postgres as decided in the implementation guide. If the broader architecture supersedes it, only Phases 1 and 2 change.
