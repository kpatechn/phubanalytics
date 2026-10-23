# Documentation

Start here if you're new to PlayerHub Analytics. Read in this order.

| # | Document | What it covers |
|---|---|---|
| 1 | [implementation-plan.md](implementation-plan.md) | The original plan: audiences, metrics, phases, decisions. Where the build differs, the documents below say so |
| 2 | [../README.md](../README.md) | The repository: apps, running locally, tests, the API, differences from the plan |
| 3 | [schema-validation.md](schema-validation.md) | How the plan was checked against the Graton dev database, and what was found there |
| 4 | [../db/README.md](../db/README.md) | The database layer: rollup design, tables, refresh, the `dextrans` link, deploying to an environment |
| 5 | [dextrans-review.md](dextrans-review.md) | Every `dextrans` table reviewed for analytics value, data quality and personal data; what was built (P1) and what's next |
| 6 | [production-rollout.md](production-rollout.md) | Step-by-step production rollout, rollback, monitoring and runbook |
| 7 | [../db/rollback/README.md](../db/rollback/README.md) | Rollback scripts and their order |

## Where things are

| Path | Contents |
|---|---|
| `apps/api` | Fastify summary API (`src/repo.ts`, `src/platform.ts` hold every query) |
| `apps/web` | Angular dashboard (`src/app/analytics` pages, `src/app/shared` components, `insights.ts` rules, `metrics.ts` definitions) |
| `packages/contracts` | Response types shared by API and web |
| `db/migrations` | 001 event rollups, 002 engagement, 003 `dextrans` link |
| `db/seeds`, `db/ops`, `db/tests`, `db/rollback` | Configuration data, operational scripts, checks, rollbacks |
| `db/cdp-mock` | Mock Chickasaw CDP data for the GEM dev database, built around the real WinStar sample ([README](../db/cdp-mock/README.md)) |
| `db/cdp` | Chickasaw CDP prototype: activity across sites, player profiles, reachability, segments ([README](../db/cdp/README.md)) |
| `scripts` | Local test harnesses, the `dextrans` link script, the dev `.env` writer, the Chickasaw mock and CDP builders |

## Environments

| Environment | State |
|---|---|
| Graton dev | Migrations 001–003, `dextrans` link and pg_cron refresh live since 2026-10-22 |
| GEM dev (Chickasaw) | Since 2026-10-23, in `dexiga`: mock data in schema `cdp_mock` and the CDP prototype in schema `cdp`. Nothing else from this repository is deployed there |
| Staging, production | Not deployed. Follow [production-rollout.md](production-rollout.md) |

Data rules: this repository may contain Graton configuration (property, geofence names) but never raw event exports or credentials. The public demo repository `kpatechn/playerhub-insights` takes sample data only. Chickasaw data stays in the GEM dev database: the mock generators here hold no real data, and their output must not be copied to Graton's databases or to the public repository.
