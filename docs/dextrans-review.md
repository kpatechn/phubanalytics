# What `dextrans` can add to the analytics dashboard

Reviewed 2026-10-22 on Graton dev (database `dextrans`), read-only, aggregates only: no personal values were read out. Counts below are dev data (test accounts and test campaigns mixed with real configuration).

> **Status 2026-10-22:** the P1 items are live on Graton dev: message delivery health (#1), campaign funnel (#2), platform and app version (#8), device mix (#9), tier segmentation (#12) and scheduled job health (#21), through `postgres_fdw` (section 6). See `db/README.md`. Also found while building: a second logging bug, `No active profile found for campaign id: {campaign.Id}`, and 2 campaign IDs (3,216 messages) missing from `campaignMaster`.

## 1. Overview

- 93 tables in 14 schemas. About 40 hold data; about 30 are empty (section 5).
- **How it links to the app events** (database `dexl`):

| Key | From the app events | Into `dextrans` | Coverage |
|---|---|---|---|
| Account | `userId` | `dexauth.accounts`, `deviceInfos`, `dexifier.inboxes` | 16 of 17 accounts |
| Account → player | `userId` | `dexpatron.cards` (tier), `dexpatron.profiles` | 13 of 17 |
| Session | `sessionId` | `dexauth.userSessions` | 764 of 764 |
| Inbox message | `attributes.notification_id` | `dexifier.notifications` → `phcamp.campaignStats` | 100% / 99.9% |
| Player card | via `cards.playerCard` | `dexpatron.zones`, `markerStatus`, `dexcomm.apnLogs.accountNo` | 23/24, 14/45, 35/112 |
| Profile | `profiles.id` | `profileExtension`, `clubs`, `campaignStats.profileId` | 100% |

- `dexl` and `dextrans` are separate databases, so the dashboard can't join them today (see section 6).

## 2. Candidates, by dashboard area

Priority: **P1** = real value now, data in shape. **P2** = useful, needs a fix or more data. **P3** = later, module not live or too little data.

### Messaging and campaigns (Marketing, IT)

| # | Table(s) | What it adds | Dev data | Priority |
|---|---|---|---|---|
| 1 | `dexcomm.apnLogs` | **Delivery health of every outbound message**: sent, delivered, failed by type (push, email, SMS, real-time, check-in/out, room ready, OTP) and by failure reason; monthly trend | 28,687 sends since Feb. Push 59% failed; real-time, campaign, SMS, check-in/out and room-ready ~97–100% failed. Top reasons: device token unavailable 6,898; notification/channel config missing 5,464; no campaign for the trigger event 2,687; missing email 639 / phone 428 | **P1** |
| 2 | `phcamp.campaignMaster` + `campaignStats` | **Campaign funnel per campaign**: sent → delivered → opened → clicked → converted, unsubscribes; by category, audience type, schedule type. Gives the per-campaign results app events can't (push opens say `unknown_campaign`) | 49 campaigns, 9,281 recipient rows. Push: 9,257 sent, 120 delivered, 108 opened, 29 clicked, 6 converted, 13 unsubscribed | **P1** (needs test-campaign exclusion) |
| 3 | `dexifier.items` + `inboxes` + `notifications` | **Inbox deliveries** per channel, read, CTA completed, deleted: the denominator for the app's message funnel | 3,099 items (2,818 push, 280 email); 74 read (2.6%), 0 CTA, 83 deleted | P2 |
| 4 | `dexifier.dcChannels` + `userDevices` | **Reachability**: accounts with a push token, channel consent per inbox (push, SMS, email) | 910 push tokens across 87 accounts; 79 channel consents, all "accepted" | P2 (no declines recorded) |
| 5 | `phcamp.staticAud*`, `dynamicAud*`, `campaignAudience` | **Audience size** per campaign; targeted vs reached | 7 static lists (33,428 members), 9 dynamic (74) | P2 |
| 6 | `phcamp.templates`, `eventMaster`, `dexifier.deliveryWindows` | Marketing operations inventory: templates by channel, real-time triggers (geofence entry/exit, card linked/unlinked), delivery windows | 198 templates (147 push), 23 triggers, 141 windows | P3 |
| 7 | `phcamp.campaignOffers`, `campaignOfferCodes`, view `vwOfferRedemption` | **Offer redemption** | 1 offer, 2 codes, view returns 0 rows | P3 (not populated) |

### App usage context (Engagement, IT)

| # | Table(s) | What it adds | Dev data | Priority |
|---|---|---|---|---|
| 8 | `dexauth.userSessions` | **Platform and app-version split** of every metric, **session length**, sessions per account, version adoption after a release | 1,121 sessions (iOS 623, Android 498), 5 app versions; median session 1.8 min iOS, 0.5 min Android; joins 100% to app events | **P1** |
| 9 | `dexauth.deviceInfos` | **Device mix** (iOS, Android, Mac, web), device models, devices per account, trusted devices | 1,666 devices: Android 832, iOS 678, Mac 114, web 41; 58 Android models | **P1** |
| 10 | `dexauth.accounts` + `dexUsers` | **Sign-ups per day**, accounts with a linked player card, terms accepted, OTP/SMS retries, lockouts: a sign-up and login funnel from the server side | 536 accounts, 366 active, 175 with a card, 5 ever locked out | P2 |
| 11 | `dexauth.authTokens` | Logins (tokens issued) per day, revocations, devices per account | 968 tokens, 839 revoked, 131 accounts | P3 |

### Guests and loyalty (segments for every page)

| # | Table(s) | What it adds | Dev data | Priority |
|---|---|---|---|---|
| 12 | `dexpatron.cards`, `currentClub`, `clubs` | **Tier segmentation**: DAU, feature reach, retention and campaign response by tier; tier mix of app users | Inspire 141, Fortune 58, Chairman 57, Prosper 55, Royalty 35 | **P1** |
| 13 | `dexpatron.zones` | **On-property visits from the server**: entries, exits, dwell by geofence and point of interest; visit frequency per guest | 23,737 events since Mar (21,017 entries, 2,289 POI entries, 23 dwells), 24 players, 7 geofences, 6 POIs: ~70× the app's geofence events | P2 (most rows have no type) |
| 14 | `dexpatron.markerStatus` | **Marker (casino credit) adoption**: app users with an active marker, enrollments started in the app | 15,902 records (12,532 declined, 2,331 active, 763 awaiting signature); 15,627 pre-date the app | P2 |
| 15 | `dexpatron.profileExtension` (via `profiles`) | **Demographics** (age group, gender), VIP / high-value / local flags, communication preferences by topic, self-exclusion and bans for **responsible gaming** | 403 profiles; age and gender are numeric codes (lookup needed); VIP/local all false; self-exclusion and ban never set | P2 (codes, empty RG fields) |
| 16 | `dexpatron.profiles` | Profile creation dates; keys only | 425 profiles | Keys only (PII) |

### Hotel and guest services

| # | Table(s) | What it adds | Dev data | Priority |
|---|---|---|---|---|
| 17 | `dexpatron.digitalKeyTrans` | **Digital room key funnel**: setup, fetch keys, unlock, errors | 1,001 transactions, Dec 2025 only; 1 error | P3 (stale) |
| 18 | `apnLogs` check-in / check-out / room-ready + `dexcron` jobs | Hotel notification reliability | ~97% of these sends failed | P2 |
| 19 | `dexpatron.feedbacks`, `contactUs` | Feedback and contact volume by topic | 37 feedbacks; 12 contacts (dining 8) | P3 (free text with PII) |
| 20 | `dexhost.*`, `dexpatron.hosts`, `hostedPlayers` | Host program coverage | 4 hosts, 1 hosted player | P3 |

### Platform operations (IT)

| # | Table(s) | What it adds | Dev data | Priority |
|---|---|---|---|---|
| 21 | `dexcron.jobStatus`, `jobs`, `jobSchedules` | **Scheduled job health**: runs, failure rate, duration and last run per job; alert on silent jobs | 157,638 runs; failures: check-out 220, check-in 216, room ready 126, notificationService 106, delivery window 6 of 35 | **P1** |

### Content and gamification

| # | Table(s) | What it adds | Dev data | Priority |
|---|---|---|---|---|
| 22 | `phcms.contentEntries`, `contentTypes`, `contentVersions`, `hierarchicalPages` | **Content freshness**: last published per type ("promotions last published Apr 3"), drafts; join app content views to CMS entries by title | 538 entries: tier benefits 187, events 44, dining 25 (updated Oct 21), promotions 19 (last Apr 3) | P2 |
| 23 | `dexam.assets`, `versions`, `metadatas` | Media assets nearing expiry | 272 images | P3 |
| 24 | `dexprog.*` | **Progressive jackpot / gamification**: on-property play sessions, meters, rewards posted vs failed | 17 players, 14 sessions, 17 wagers, 14 rewards (10 posted, 2 failed); all Jan 2026 | P3 (module not live) |

## 3. Data-quality issues to fix at the source

| Issue | Evidence | Effect |
|---|---|---|
| Test campaigns and jobs mixed with real ones | Campaigns "testing", "test", "Dev Test - Players"; job "Dev Test-6" | Funnel and failure rates distorted; needs an `isTest` flag or exclusion list |
| Failure log writes a template literally | 562 failures with the text `Error: {ex.Message}` | Real error lost; logging bug |
| Trip and journey IDs are one per session | 1,119 trips for 1,121 sessions | Can't group sessions into visits yet |
| Message status never changes | All 23,602 `dexifier.notifications` are `new` | No lifecycle from this table; use `apnLogs` and `campaignStats` |
| Half the inbox items point to missing inboxes | 1,580 of 3,099 `items` | Per-guest inbox metrics undercount |
| Campaign delivery tracked only since Aug 21 | `deliveredAt` starts 2026-08-21; 1 row dated 2027 | Earlier campaigns show 0 delivered |
| Channel consent has no declines | All 79 `dcChannels` rows accepted | Opt-in rate would read 100% |
| Demographic codes | `ageGroup`, `genderType` stored as numbers | Need the code lists |
| Geofence events mostly untyped | 21,081 of 23,737 `zones` rows have no `type` | Geofence vs POI split incomplete |

## 4. Sensitive data (never copy into `dexl.analytics`)

- **`dexauth.accounts.otp` holds OTP codes in plain text (485 rows).** A security issue worth raising with the platform team.
- `dexauth.authTokens`: refresh tokens, IP addresses, latitude/longitude.
- `dexpatron.profiles`, `hosts`, `reservations`, `feedbacks`, `contactUs`, `dexprog.players`: names, emails, phone numbers, IDs, addresses, birthdays, free text.
- `dexcomm.apnLogs.accountNo`, `campaignOffers.accountNo`: player card numbers.

Rollups should carry only counts and pseudonymous keys (account UUID), never these fields.

## 5. Empty or not usable yet

`dexchat.*` (6 channels, 0 messages), `dexcomm.emailLogs`, `smsLogs`, `subscribers`, `subscriptions`, `subsEventLogs`, `dexcomm.notifiedStatus` (Feb only), `dexifier.geoEvents`, `geofenceLogs`, `geofences`, `groups`, `targets`, `dexpatron.digitalKeys`, `nextClub`, `reservations`, `rooms`, `userPrefs`, `dexpayment.paymentMethods`, `dexplay.transactions` (cashless wallet transactions), `dexprog.consentLog`, `dataExportRequests`, `notifications`, `privacyPreferences`, `triggerHistories`, `phcamp.promoGamification`, `phorg.commGroups`, `commPrefs`.

Worth revisiting when populated: `dexplay.transactions` (wallet funding volume), `dexpatron.reservations` (hotel), `dexprog.privacyPreferences` and `consentLog` (consent and deletion requests).

## 6. How to bring it in

`dexl` and `dextrans` are separate databases. Recommended: **`postgres_fdw` in `dexl`** (available on this RDS instance, not installed) with a read-only `dextrans` role, and new rollups in `dexl.analytics` refreshed by the existing pg_cron job. The dashboard keeps reading only `dexl.analytics`, personal data stays in `dextrans`, and joins to app events happen inside the rollup.

Alternatives: a second database connection in the API (no joins with app events), or logical replication of the needed tables (more moving parts).
