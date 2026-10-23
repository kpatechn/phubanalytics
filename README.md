# PlayerHub App Analytics

Executive, Engagement, Marketing and IT & Operations dashboards for the PlayerHub mobile app, built on the `dexl.analytics` rollups, plus a Chickasaw CDP section (segments, sites, Player 360) on the GEM database.

New here? Start with the [documentation index](docs/README.md).

| Path | What it is |
|---|---|
| `apps/api` | Fastify 5 + postgres.js summary API (Node 24, TypeScript, zod) |
| `apps/web` | Angular 21 dashboard (standalone, signals, zoneless, ECharts) |
| `packages/contracts` | Response types shared by both |
| `db/` | Rollup migration, seeds, checks and pg_cron schedule ([db/README.md](db/README.md)); Chickasaw mock data and CDP layer ([db/cdp/README.md](db/cdp/README.md)) |
| `docs/schema-validation.md` | How the plan was checked against the Graton dev database |
| `docs/production-rollout.md` | Step-by-step production rollout, rollback and runbook |

## Run locally

Needs Node 24+ and a `graton-dev` entry in `~/.pg_service.conf` with its password in `~/.pgpass`. For the Chickasaw CDP section, also a `gem-dev` entry (GEM dev, VPN only) and the `cdp` schema built there (`scripts/build-cdp.sh`).

```bash
npm install
```
```bash
scripts/write-dev-env.sh
```
```bash
npm run dev:api
```
```bash
npm run dev:web
```

Open http://localhost:4200. The web dev server proxies `/api` to the API on port 3000.

`write-dev-env.sh` writes `apps/api/.env` (mode 600, git-ignored) from your existing logins; it adds `GEM_DATABASE_URL` when a `gem-dev` entry exists, and without it the CDP section stays hidden. The API opens every database session read-only with a 10 s statement timeout, whatever role the URL uses. With `AUTH_MODE=dev` (allowed only when `APP_ENVIRONMENT=dev`) every request is treated as `analytics:admin`.

## Test

```bash
npm test
```
```bash
npm run test:integration -w @phub/api
```

`npm test` runs the API tests (auth 401/403/200, validation, caching, date ranges, the CDP endpoints) and the insight-rule tests (below minimum sample, at threshold, above). The integration test reads the plan's golden values for 2026-09-03 to 2026-10-02 from Graton dev through the API's own queries, and recounts DAU, WAU, MAU and new accounts for every day straight from raw events. With `GEM_DATABASE_URL` set, it also checks the CDP queries against direct counts in GEM dev.

## API

`GET /api/analytics/{executive|engagement|marketing|it}?from=YYYY-MM-DD&to=YYYY-MM-DD&property=1500001`

- **Range:** dates are inclusive, in the property's time zone. With no dates, the last 30 days. The maximum is 366 days.
- **Response:** `{ meta, data }`. `meta` carries the range, the previous period (for deltas), the property, `dataAsOf` and `lastRefreshAt`.
- **Errors:** `application/problem+json`.
- **Roles:** `analytics:exec` (Executive and Engagement), `analytics:marketing`, `analytics:it`; `analytics:admin` passes every check.
- **Engagement:** DAU, trailing WAU (7 days) and MAU (30 days), DAU/MAU and WAU/MAU, new vs returning, weekly retention cohorts, feature reach, on-property active accounts, tiers and platforms. Active means at least one foreground event (see [db/README.md](db/README.md)).
- **Platform data** (from database `dextrans`): message delivery and failure reasons (Marketing, IT), campaign results (Marketing), app versions, session length and devices (IT), scheduled job health (IT), tier segmentation (Engagement). `meta.dextransAsOf` says when it was last refreshed.
- **Caching:** 60 s in memory, plus `Cache-Control` and an `ETag`.

Also: `GET /api/analytics/me`, `GET /api/analytics/properties`, `GET /healthz`, `GET /readyz` (503 when the rollups haven't refreshed for 30 minutes).

### Chickasaw CDP

`GET /api/cdp/{meta|segments|sites}`, `GET /api/cdp/players/examples?segment=champions`, `POST /api/cdp/players/lookup` with `{ "accountNumber": "…" }`.

- **Source:** schema `cdp` in the GEM database (`GEM_DATABASE_URL`), through its own read-only pool. Without that setting the `cdp` view is hidden and these endpoints answer 404; before the first `cdp.refresh()` they answer 503.
- **Role:** `analytics:cdp` (or `analytics:admin`).
- **Response:** `{ meta, data }`. `meta` carries the 12-month window, when the CDP was last refreshed, every feed with its real/mock flag, and the site list. The dashboard shows a mock-data banner from it.
- **Account numbers** travel only in the lookup's request body and in response bodies, never in URLs or logs. Responses that carry them are `no-store`; segment and site aggregates are cached for 5 minutes.

## Where this differs from the plan

- **No `env` query parameter.** Each database is one environment, so the API takes `property` and reports the property's environment.
- **Rollups only.** The API reads `dexl.analytics` rollups, never raw events. Distinct-guest counts come from the guest rollups, so long ranges stay fast.
- **"Accounts logged in" counts accounts (`userId`)**, not mixed `player_id` values (8, not 13, for the golden window).
- **No UI component library yet.** The shell, tabs and controls are plain Angular plus design tokens, so a library can still be chosen (plan open question 3).
- **Auth is JWT against a JWKS URL**, roles taken from one claim (`JWT_ROLES_CLAIM`). The identity provider is still open (plan open question 4).
