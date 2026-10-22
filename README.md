# PlayerHub App Analytics

Executive, Marketing and IT & Operations dashboards for the PlayerHub mobile app, built on the `dexl.analytics` rollups.

| Path | What it is |
|---|---|
| `apps/api` | Fastify 5 + postgres.js summary API (Node 24, TypeScript, zod) |
| `apps/web` | Angular 21 dashboard (standalone, signals, zoneless, ECharts) |
| `packages/contracts` | Response types shared by both |
| `db/` | Rollup migration, seeds, checks and pg_cron schedule ([db/README.md](db/README.md)) |
| `docs/schema-validation.md` | How the plan was checked against the Graton dev database |

## Run locally

Needs Node 24+ and a `graton-dev` entry in `~/.pg_service.conf` with its password in `~/.pgpass`.

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

`write-dev-env.sh` writes `apps/api/.env` (mode 600, git-ignored) from your existing login. The API opens every database session read-only with a 10 s statement timeout, whatever role the URL uses. With `AUTH_MODE=dev` (allowed only when `APP_ENVIRONMENT=dev`) every request is treated as `analytics:admin`.

## Test

```bash
npm test
```
```bash
npm run test:integration -w @phub/api
```

`npm test` runs the API tests (auth 401/403/200, validation, caching, date ranges) and the insight-rule tests (below minimum sample, at threshold, above). The integration test reads the plan's golden values for 2026-09-03 to 2026-10-02 from Graton dev through the API's own queries.

## API

`GET /api/analytics/{executive|marketing|it}?from=YYYY-MM-DD&to=YYYY-MM-DD&property=1500001`

- **Range:** dates are inclusive, in the property's time zone. With no dates, the last 30 days. The maximum is 366 days.
- **Response:** `{ meta, data }`. `meta` carries the range, the previous period (for deltas), the property, `dataAsOf` and `lastRefreshAt`.
- **Errors:** `application/problem+json`.
- **Roles:** `analytics:exec`, `analytics:marketing`, `analytics:it`; `analytics:admin` passes every check.
- **Caching:** 60 s in memory, plus `Cache-Control` and an `ETag`.

Also: `GET /api/analytics/me`, `GET /api/analytics/properties`, `GET /healthz`, `GET /readyz` (503 when the rollups haven't refreshed for 30 minutes).

## Where this differs from the plan

- **No `env` query parameter.** Each database is one environment, so the API takes `property` and reports the property's environment.
- **Rollups only.** The API reads `dexl.analytics` rollups, never raw events. Distinct-guest counts come from the guest rollups, so long ranges stay fast.
- **"Accounts logged in" counts accounts (`userId`)**, not mixed `player_id` values (8, not 13, for the golden window).
- **No UI component library yet.** The shell, tabs and controls are plain Angular plus design tokens, so a library can still be chosen (plan open question 3).
- **Auth is JWT against a JWKS URL**, roles taken from one claim (`JWT_ROLES_CLAIM`). The identity provider is still open (plan open question 4).
