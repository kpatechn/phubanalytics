# Schema validation: analytics plan vs Graton Dev database

Checked 2026-10-22 against `playerhub-phub-graton-dev-uw2-pg` (PostgreSQL 16.13), read-only, as `phub_dev_admin`.
Companion to [implementation-plan.md](implementation-plan.md). No player IDs, session IDs or other identifiers are reproduced here.

## 1. Headline

The events in `mob-analytics-log.xlsx` are already in Postgres, and so is an early version of the rollup layer the plan describes.

| Plan assumption | What the database shows |
|---|---|
| Data exists only as an xlsx export (open question 5) | Raw events are in database `dexl`, table `data."dexAnalytics"`: 12,852 rows, 2026-08-11 to 2026-10-21, still receiving events |
| Need to create `analytics_event`, `analytics_daily`, `analytics_error_daily` | Schema `dexl.analytics` already has `eventDaily`, `eventHourly`, `eventDimensionDaily`, `apiErrorEndpointDaily`, `apiErrorMessageDaily`, `userEventDaily`, fed by an insert trigger and a backfill procedure |
| Multi-property is undecided (open question 1) | Already decided in practice: every table carries `tenantId` + `propertyId` (Graton = 15001 / 1500001) |
| Event names are display strings ("Login success") | Stored as snake_case `eventId` (`login_completed`). Display names only exist in the export |
| One database | Analytics are in database `dexl`; sessions, campaigns, inbox, push and player tables are in database `dextrans`. No `postgres_fdw`/`dblink` installed |

## 2. Golden fixture checks (plan section 4)

Window: 2026-09-03 00:00 to 2026-10-03 00:00 `America/Los_Angeles`, raw table `dexl.data."dexAnalytics"`.

| Check | Expected | Database | Result |
|---|---|---|---|
| Total events | 3,494 | 3,494 | Pass |
| Sessions started | 186 | 186 | Pass |
| App opens | 230 | 230 | Pass |
| Login attempts / successes | 58 / 55 | 58 / 55 | Pass |
| Distinct accounts logged in | 13 | 13 by `attributes.player_id`, 8 by `userId` column | See 4.1 |
| On-property events | 1,877 | 1,877 | Pass |
| API errors | 438 | 438 | Pass |
| Errors on analyticLogs / points | 227 / 159 | 227 / 159 | Pass |
| Inbox views / opened / read / deleted | 84 / 38 / 38 / 76 | 84 / 38 / 38 / 76 | Pass |
| Push opens / foreground receipts | 16 / 20 | 16 / 20 | Pass |
| Geofence entries / exits | 327 / 9 | 327 / 9 | Pass |
| Biometric passed / failed | 21 / 2 | 21 / 2 | Pass |

Section 3 findings also reproduce: OTP 47 of 55 logins (PIN 5, credentials 3), wallet 70% offsite (53 of 76), card-link starts 74% offsite (26 of 35), denials 18 `skipped` / 2 `permanently_denied`, `is_cta_completed` false on 38 of 38, push `campaign_id` = `unknown_campaign` on 16 of 16, notification permission granted 204.

The golden test can run straight against this table. The existing rollups cannot reproduce it: they start 2026-10-01 (see 3).

## 3. Existing rollup layer (`dexl.analytics`)

> **Status 2026-10-22:** owner confirmed `dexl.analytics` is new and can be redesigned. Replaced by `db/migrations/001_analytics_rollups.sql` (see `db/README.md`), which fixes R1–R8. Tested locally on a scrubbed copy of all 12,852 dev events: every golden value reproduces from the rollups, and rebuilds, late events, deletes, DST, exclusions and concurrent refreshes all pass. Applied to Graton dev 2026-10-22 16:15 UTC: rebuild of 72 days / 12,852 events in 0.5 s, and all 24 rows of `db/tests/rollup_checks.sql` pass on dev. Old schema backed up before the change. Scheduled with pg_cron every 5 minutes; the first scheduled run (18:25 UTC) succeeded.

Pipeline (old): `AFTER INSERT` trigger on `data."dexAnalytics"` → `analytics."mobAnalyticsIngestDelta"` → `analytics."processMobAnalyticsIngestDelta"(batch)` adds counts into the rollups and deletes the deltas. `analytics."backfillMobAnalyticsHistory"` replays history in chunks. Backfill ran once, 2026-10-21 13:23 UTC, for 2026-10-01 onward.

Issues against the plan:

| # | Issue | Evidence | Effect |
|---|---|---|---|
| R1 | Days and hours are bucketed in UTC | `"createdDate"::date` with server `TimeZone = UTC`. Rollup totals match raw UTC days exactly but differ from Pacific days (e.g. Oct 14: 153 UTC vs 323 PT; Oct 15: 765 vs 595) | Daily charts shift by 7–8 hours. Plan requires property-local days |
| R2 | Nothing is processing deltas | 199 deltas waiting since 2026-10-21 13:45 UTC. No `pg_cron`; no `dexcron` job found | Rollups are stale from that point |
| R3 | Rollups only cover 2026-10-01 onward | `mobAnalyticsBackfillRange` ranges 2–22 | Golden window not in rollups |
| R4 | Increment-only upserts | `eventCount = eventCount + EXCLUDED` | Not idempotent. A replayed delta double-counts. Plan wants a recompute of the last two local days |
| R5 | Permission split ignores `denial_type` | Classifies on `permission_status`/`status`/`outcome` and event name | `skipped` vs `permanently_denied` (18 / 2) is lost |
| R6 | `userEventDaily` keyed on `userId` for `login_completed` and `api_error` only | | Distinct-guest counts disagree with the plan's 13 (see 4.1) |
| R7 | Error message cut to first line, 70 chars | | Fine for grouping; plan says 500 |
| R8 | No feature dimension, no screen-to-feature map | | Feature usage must be computed from raw or a new rollup |

## 4. Data findings the plan does not cover

### 4.1 Identity
- `userId` column (NOT NULL) is the dex account UUID: 16 of 17 match `dexauth.accounts."userId"`.
- `attributes.player_id` is mixed: of 27 distinct values, 15 match player card numbers (`dexauth.accounts."playerCard"`, `dexpatron.cards."playerId"`) and 12 match account UUIDs. Within the golden window, the 13 player_ids map to 8 accounts (24 userId/player_id pairs: test devices are shared).
- `dexauth.accounts` links the two (`userId` ↔ `playerCard`), so a normalized guest key is possible server-side today without waiting for Track B.

### 4.2 Server-side data that can replace or check app events (database `dextrans`)

| Table | Rows / range | Join from app events | Use in dashboard |
|---|---|---|---|
| `dexauth."userSessions"` | 1,117 sessions, 2026-08-11 → 10-21. `platform`, `appVersion`, `deviceId`, `playerId`, `locationContext`, start/end | `sessionId` → 760 of 760 match | Platform and app-version splits, session length, sessions per player. Covers most of the Phase 5 envelope fields now |
| `dexifier.notifications` + `dexifier.items` | 23.6k messages; 3,099 inbox items (read 74, CTA 0, deleted 83) | `attributes.notification_id` → 124 of 124 match `notifications.id` | Inbox funnel with a real "delivered" denominator |
| `phcamp."campaignStats"` + `"campaignMaster"` | 9,281 recipient rows, 49 campaigns. Sent 9,136 push; opened 108, clicked 29, converted 6, unsubscribed 13 | `campaignStats."notifyId"` → `notifications.id` (9,275 of 9,280) | Per-campaign results for inbox messages, even though push events say `unknown_campaign` |
| `dexcomm."apnLogs"` | 28,687 sends since 2026-02-12: FAILED 18,984, DELIVERED 9,678 | Push `message_id` does not match (`messageId` mostly blank) | Push delivery failure rate (IT and Marketing). Missing from the plan |
| `dexpatron.zones` | 23,737 geofence events since 2026-03-01, `entry`/`exit`/`dwell` | 3 of 14 `geofence_id` values match `"geoFenceId"` | Server-side geofence counts are ~70× the app's |
| `phcamp."eventMaster"` | 23 trigger definitions, 21 geo | `geofence_id` codes do not match `code` | Possible source of zone display names (needs mapping) |
| `dexl.logs` (both DBs) | Gateway request/response logs, service `MOB-YARP` (.NET YARP) | by path | Server view of `analyticLogs` and `points` failures |

Push opens cannot be tied to a campaign: `push_opened.message_id` is an FCM ID and is not stored on the server side.

### 4.3 Server logs vs client-reported errors (golden window)
- `analyticLogs`: 5,516 requests logged, only 250 responses: 82 OK, 156 `406 ERR`, 12 `500`. The client reported 197 × HTTP 400. Status codes differ between gateway and client, and most responses are not logged.
- `points`: 86 requests, 83 `406 ERR` at the gateway; the client reported 159 × HTTP 500 `TLGY01`.
- The ingest endpoint sits behind the .NET YARP gateway (answers part of open question 2).

### 4.4 Privacy (sensitive data already stored)
- 125 rows have `sessionId`/`playerId` query params in `attributes.url` (plan section 6 scrub rule).
- `fast_funds_viewed` stores an unmasked `account_number` (7–9 digits).
- 1,848 rows carry `latitude`/`longitude`.
- `rawPayload` is `{}` or near-empty on almost every row; no tokens found there.

### 4.5 Other
- Duplicate copy: `dextrans.dexl."dexAnalytics"` and `dextrans.dexl.logs` are identical to the `dexl` database up to 2026-10-16 (checksum match on 10,502 IDs) and frozen since. Owner confirmed 2026-10-22: no longer used; ignore.
- 13 numeric `eventId`s (`83`, `4`, `2`, `10`, …; 330 rows) exist only before 2026-09-03. Legacy codes with no catalog entry.
- `data."eventAnalytics"` (288 rows) maps `eventId` → `mobileName`, but `mobileName` is a per-event label (screen, zone, message title), not a display name. No category on 287 of 288 rows.
- Geofence names are inconsistent: the same `geofence_id` appears under its zone name and under its parent code (e.g. `Zone A` and `1500001-0003`). About 7 of 14 zones are staff or office test zones.
- `campaignId`, `messageId`, `correlationId`, `transactionId` columns exist on the event table but are filled on 0.1% of rows.
- `session_ended` and `app_backgrounded` (207 each in the window) give session length but are not in the plan.

## 5. Event name map (plan → database `eventId`)

Use `eventId` in `analytics_feature_map` and all queries.

| Plan name | eventId | Window count |
|---|---|---|
| Cashless Wallet screen opened | `wallet_screen_viewed` | 46 |
| Wallet balance refreshed | `wallet_balance_checked` | 30 |
| Fast Funds screen/WebView opened | `fast_funds_viewed` | 32 |
| Inbox list viewed | `notification_list_viewed` | 84 |
| Live drawing screen opened | `live_drawing_viewed` | 12 |
| Promotions screen viewed | `promotions_screen_viewed` | 9 |
| Promotion details viewed | `promotion_details_viewed` | 10 |
| Offers list rendered | `offer_list_viewed` | 4 |
| Events list page opened | `event_list_viewed` | 4 |
| Event details page opened | `event_details_viewed` | 8 |
| Gaming hub screen viewed | `gaming_hub_screen_viewed` | 6 |
| Table games main screen viewed | `table_games_screen_viewed` | 3 |
| Slots screen viewed | `slots_screen_viewed` | 1 |
| Live poker screen viewed | `live_poker_screen_viewed` | 1 |
| (not in plan) High limit | `high_limit_screen_viewed` | 0 (4 outside window) |
| Restaurants list viewed | `restaurant_list_viewed` | 5 |
| Property Info screen viewed | `resort_info_viewed` | 5 |
| Resort pool screen viewed | `pool_screen_viewed` | 1 |
| Link flow started | `link_account_clicked` | 35 |
| (not in plan) Link completed | `link_account_completed` | 0 (2 after window) |
| tier_status_viewed | `tier_status_viewed` | 3 |
| Win/loss tax report sent | `winloss_statement_requested` | 2 |
| Login process started | `login_initiated` | 58 |
| Login success | `login_completed` | 55 |
| User logged out | `logout_completed` | 3 |
| Notification detail opened | `notification_details_viewed` | 38 |
| Notification marked read | `notification_marked_read` | 38 |
| Notification deleted | `notification_deleted` | 76 |
| Player opened push notification | `push_opened` | 16 |
| Platform/device handling outcome | `push_device_handled` | 20 |
| (not in plan) Push CTA clicked | `push_cta_clicked` | 0 (8 before window) |
| FaceID/TouchID passed / failed | `biometric_validation_completed` / `_failed` | 21 / 2 |
| (not in plan) PIN passed / failed | `pin_validation_completed` / `_failed` | 1 / 0 |
| Generic button tap | `button_clicked` | 207 |
| Pull to refresh | `pull_to_refresh` | 73 |
| (not in plan) Gift & Go claim / redeem | `gift_and_go_claim_clicked`, `_redeem_initiated`, `_redeem_success` | 0 (8 each after window) |
| (not in plan) Session end / background | `session_ended`, `app_backgrounded` | 207 / 207 |
| (not in plan) Location denied / always denied, permission changed, opted out | `location_permission_denied`, `location_permission_always_denied`, `notification_permission_changed`, `permission_opted_out` | 0 in window |
| Unchanged | `session_started`, `app_opened`, `api_error`, `page_open`, `webview_viewed`, `geofence_entered`, `geofence_exited`, `notification_permission_granted`, `notification_permission_denied`, `location_permission_granted`, `bluetooth_permission_granted` | |
