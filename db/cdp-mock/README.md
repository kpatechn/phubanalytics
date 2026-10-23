# Mock Chickasaw CDP data (`cdp_mock`)

Mock data for prototyping a customer data platform (CDP) for Chickasaw, built around the real WinStar loyalty sample in the GEM dev database (`dexiga`).

What Chickasaw told us (2026-10-23): one loyalty system per site; one Club Passport account, tier and points balance shared across sites; a central system keeps profiles in sync; non-gaming lives in Agilysys systems (LMS, Stay, Versa, Spa, Golf, products) reachable through their data warehouse, with the Club Passport number on each record; no email or SMS opt-ins are kept yet; the Chickasaw app will send events through the PlayerHub analytics feed. Right now we only have WinStar's gaming data. Everything else here is generated.

**This is not real activity.** Mock rows reuse real WinStar account numbers, so one player can have real WinStar play and mocked activity elsewhere. They never copy names, contacts or addresses: emails are `@example.com` and mobiles use the unassigned +1 555 area code. Keep it in GEM dev. Don't copy it to Graton's databases, to production or to the public demo repository.

## Run

```bash
scripts/mock-chickasaw.sh
```

- Drops and rebuilds schema `cdp_mock` in `dexiga` (about 3 minutes, 620 MB), then runs `90_checks.sql`. It reads `dexiga` and writes nothing outside `cdp_mock`.
- The same inputs always give identical rows: every random draw is a hash of a text key (`cdp_mock.u`), not `random()`.
- Window: `START_DATE` / `END_DATE`, default 2024-06-04 to 2025-07-04, the 13 months up to the WinStar sample's last load. When a fresh WinStar load arrives, rerun with a new window.
- Remove it all: `psql "service=gem-dev dbname=dexiga" -f db/cdp-mock/drop.sql`.

| File | Builds |
|---|---|
| `00_schema.sql` | Schema, helper functions, sites, tiers, the player base |
| `10_visits_gaming.sql` | Visits at every site; gaming at the seven mocked sites |
| `20_non_gaming.sql` | Hotel stays, dining and retail checks, spa, golf |
| `30_consent.sql` | Contact points, opt-in ledger, current consent |
| `40_app.sql` | App users, push opt-ins, app events |
| `90_checks.sql` | Read-only checks; fails when one is off |

## Tables

Row counts are for the default window.

| Table | Grain | Rows | Notes |
|---|---|---|---|
| `site` | site | 8 | WinStar (real gaming, property `1`) plus seven mocked sites, property IDs `2`–`8` under corporate `Y`; PlayerHub tenant 16001, properties 1600001–1600008 |
| `tier` | tier | 3 | Club Passport 94, Premier 93, Elite 92, as in `dexiga.club_tier_master` |
| `player` | Club Passport account | 76,819 | Every account in WinStar's patron master (the synced enterprise list). Real tier where the club-level sample has one, else drawn |
| `visit` | player, site, day | 143,128 | WinStar: one per real trip in the sample. Other sites: mocked from home state, tier and spend |
| `gaming_trip_summary` | trip, game type | 116,585 | Shape of `dexiga.customer_gaming_activity_summary`; `summary_grouping` S = slots, G = tables |
| `slot_rating` | rating | 838,221 | Shape of `dexiga.customer_slot_rating`; ratings add up to their trip |
| `hotel_stay` | booking | 27,652 | WinStar, Riverwind, Artesian. Includes cancellations, no-shows and stays with no Club Passport number |
| `outlet` | outlet | 32 | Generic restaurant and shop names |
| `pos_check` | check | 287,361 | Dining and retail; about a quarter have no account number |
| `spa_appointment` | service | 2,713 | WinStar and Artesian, during hotel stays |
| `golf_round` | round | 1,591 | WinStar |
| `contact_point` | player, channel | 115,150 | Mock email and mobile |
| `consent_event` | opt-in or opt-out | 154,019 | Email, SMS, mail and push marketing; source, site, policy version, evidence |
| `v_consent_current` | player, channel | view | Latest status. No row means no consent |
| `app_user` | app account | 12,620 | Linked to a Club Passport number, or not yet linked |
| `app_event` | event | 615,644 | Same columns and types as `dexl` `data."dexAnalytics"`; event IDs from the event catalog |

Every mock activity table except `site`, `tier` and `outlet` carries `account_number` (Club Passport number) and, where it came from a visit, `mock_visit_id`, so mocked hotel, dining, spa, golf, gaming and app sessions for one trip line up.

## Things to test with it

- **One player across sites:** about a quarter of the players with real WinStar play also have mocked play elsewhere.
- **Identity matching:** uncarded hotel stays carry an email, and half of those match a known player's email in `contact_point`.
- **Comp reconciliation:** room comps on mocked gaming trips equal the comped stay's `comp_room_revenue`.
- **Suppression:** self-excluded players (`player.is_excluded`, from the real `dexiga.exclusion_history`) keep their mock opt-ins on purpose. The CDP must suppress them, and the checks report how many there are.
- **App linking:** app events use `userId` (the app account); `app_user` maps it to the Club Passport number, and unlinked users show up as `link_account_clicked`.

## Placeholders to correct

None of these are Chickasaw's real values. Change them in `00_schema.sql` (sites, tiers) or in the file named.

- **Sites and IDs:** property IDs, corporate ID `Y` for every site, PlayerHub tenant and property IDs, machine counts, and which sites have tables, a hotel, a spa or golf.
- **Systems:** hotel system per site (LMS at WinStar, Stay at Riverwind, Versa at Artesian), and "Agilysys POS" for dining and retail, since we don't know which product they use.
- **Visit rates:** share of Texans, Oklahomans and others who visit each site, and how often (`site.pull_*`, `site.visits_mean`).
- **Gaming model:** typical theo per visit day by tier ($40 / $150 / $450), lognormal spend index, about 6 spins a minute at a 5.5–7% hold, tables at 50 hands an hour and a 1.6% edge. Win/loss is from the player's side (negative means the player lost), as in the WinStar sample.
- **Prices:** nightly rates, outlet averages, 8.5% dining tax, 13% room tax, 18% tips, spa and golf prices (`20_non_gaming.sql`).
- **Opt-ins:** sign-up opt-in rates, unsubscribe and STOP rates, policy versions (`30_consent.sql`).
- **App:** adoption by state and tier, sessions per day, event mix (`40_app.sql`).

## Known differences from real data

- The WinStar sample holds one trip per account, so WinStar has one visit per player and thinner non-gaming than the mocked sites.
- Mocked trip summaries have no `A` (all play) rows.
- Slot ratings cover about 20 minutes each (WinStar's are about 10) to keep the table near 200 MB.
- `rating_points` is filled (slot coin-in / 5, table theo x 0.4); the WinStar sample has zeros there.
