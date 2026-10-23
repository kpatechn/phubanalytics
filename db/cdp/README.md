# Chickasaw CDP prototype (`cdp`)

A customer data platform layer for Chickasaw in the GEM dev database (`dexiga`). It brings each Club Passport player's gaming and non-gaming activity at every site into one place, then builds a profile, a per-channel reachability answer and the first segments.

It reads two kinds of feed:
- **Real:** the WinStar loyalty sample in `dexiga` (patron master, tiers, exclusions, trip summaries).
- **Mock:** everything else, from schema `cdp_mock` (see [../cdp-mock/README.md](../cdp-mock/README.md)).

Every activity row records its feed and an `is_mock` flag, and `cdp.feed` lists which feeds are real and which are mock.

## Run

```bash
scripts/build-cdp.sh
```

- Recreates schema `cdp`, runs `CALL cdp.refresh()` (about 30 seconds), then [tests/cdp_checks.sql](tests/cdp_checks.sql). Needs `cdp_mock` first (`scripts/mock-chickasaw.sh`).
- Everything in `cdp` is derived, so a rebuild loses nothing. The one exception is edits to `cdp.setting` or `cdp.segment`: rebuild with `REFRESH_ONLY=1` to keep them.
- The feed SQL lives inside `cdp.refresh()`, not in views. Rebuilding `cdp_mock` therefore never drops anything here; run the refresh again afterwards.
- Replacing a mock feed with a real one means rewriting that feed's section in `cdp.refresh()` and setting its `cdp.feed.is_mock` to false.

## Decoding WinStar's trip summaries

`dexiga.customer_gaming_activity_summary_trip_ws` holds DB2 `CFPPAS` columns. The meaning of each column comes from its position, checked against GEM's own readable layouts (`dexiga.customer_gaming_activity_summary`, `dexiga_analytical.gaming_activity_slots_summary`) and against the data itself.

| Column | Meaning | Used as |
|---|---|---|
| `cpidpas`, `pridpas` | Corporate and property ID | Site (`Y` / `1` = WinStar) |
| `acctpas` | Club Passport account | `account_number` |
| `slvlpas`, `svalpas` | Summary level `T` (trip), trip day as days since 1899-12-30 | `activity_date` |
| `sgrppas` | `S` slots, `G` and `GP` tables (no coin-in, cash buy-in), `A` all play | `game_type` slot / table / mixed |
| `tytppas` | Rating type (`SLT`, `CMP`, `PRE`, `SMS`, `RAT`, `MJP`, ...). `FUT` rows have no play and dates after the load, so they are left out | `rating_type` |
| `tstrpas` | Trip start, HHMMSS | `trip_start` |
| `dsplpas`, `ptimpas`, `nratpas` | Days played, minutes, ratings | |
| `avgbpas`, `accipas`, `accopas` | Average bet, coin-in, coin-out | |
| `ttwnpas` | Theoretical win | `theo` |
| `wnlspas` | Actual win/loss from the player's side: its sign matches coin-out minus coin-in on about 9 in 10 slot rows (jackpot rows differ) | `casino_win = -wnlspas` |
| `rtptpas` | Rating points | |
| `cmfdpas`, `cmbvpas`, `cmrmpas`, `cmotpas` + `cmtrpas`, `cmptpas`, `crn#pas` | Comps: food, beverage, room, other, total; room nights comped. Only `A` rows carry comps | |

## Tables

| Table | Grain | Rows | What it is |
|---|---|---|---|
| `feed` | feed | 12 | Every source, real or mock |
| `setting` | key | 1 | `as_of_date` override (empty = latest day with play) |
| `site` | site | 8 | Site list with corporate / property and PlayerHub IDs |
| `gaming_activity` | source trip-summary row | 156,592 | Real WinStar (40,007) plus mocked sites |
| `non_gaming_activity` | stay, check, spa service, golf round | 319,317 | Hotel, dining, retail, spa, golf, with identity method |
| `identity_link` | identifier, account | 126,124 | Emails, mobiles, app accounts pointing to a Club Passport number |
| `player_site_summary` | player, site | 67,547 | Last 12 months at each site |
| `player_profile` | Club Passport account | 76,819 | One row per player in the patron master |
| `reachability` | player, channel | 307,276 | Email, SMS, push and mail: reachable or why not |
| `segment`, `segment_member` | segment; segment, player | 12; 102,117 | Rule-based segments |
| `refresh_run` | refresh | | Start, finish, as-of date, row counts |
| views `v_player_360`, `v_segment_summary` | player; segment | | Profile with segment list; segment size and reach per channel |

Row counts are from the first build (as of 2025-07-04).

## Definitions

- **Window:** the 12 months ending `as_of_date` (364 days back). That date is the latest day with play unless `cdp.setting` overrides it. With today's data it is 2025-07-04.
- **Gaming trip:** a (player, site, day) with play (days played or theo above zero). Its gaming days are the longest `days_played` among its game types, so slots and tables on the same trip count once.
- **Visit day:** a (player, site, day) with a gaming trip or a completed non-gaming activity.
- **Theo / ADT:** theoretical win; ADT is theo divided by gaming days. `casino_win` is actual win (positive = player lost).
- **Comps:** `comps_issued` are gaming comps from trip summaries. `non_gaming_comp` is what outlets recorded as comped or paid with points. The two overlap (a room comp appears in both), so they are never added together.
- **Non-gaming amounts** exclude tax and tips. `gross` is the value sold, `paid = gross - comp - points`. Cancelled and no-show rows are kept but count toward nothing.
- **Combined value:** theo plus non-gaming paid, for 12 months. It is used for RFM monetary and the value segments.
- **RFM:** recency (days since last activity), frequency (visit days) and monetary (combined value), each scored 1–5 by percent rank in fifths among players active in the window. Tied values share a score, so reruns agree. Inactive players get no score.
- **Home site:** the site with the most visit days in the window, then highest theo.
- **Identity:** a record carries the Club Passport number (`card`). Failing that, the guest's email must belong to exactly one player (`email`); otherwise the guest stays unknown. Shared emails or mobiles are never used to match.
- **Reachability:** a channel is reachable when there is a contact (email, mobile, linked app account, or mailing address), the current consent is an opt-in, and the player isn't self-excluded. The reason is the first that applies: `self_excluded`, `no_contact`, `opted_out`, `no_consent`.
- **Self-exclusion:** any entry in `dexiga.exclusion_history` excludes a player from reachability and from every segment. There is no expiry logic yet.

## Segments

| Code | Rule |
|---|---|
| `champions` | R, F and M all 4+ |
| `high_value_at_risk` | M 4+, R 2 or less |
| `new_players` | Signed up in the last 90 days |
| `one_visit` | One visit day, more than 60 days ago |
| `lapsed` | Member for a year or more, no activity in 12 months |
| `multi_site` | Two or more sites in 12 months |
| `ok_winstar_only` | Oklahoma resident whose only site is WinStar |
| `hotel_guests` | At least one completed stay |
| `non_gaming_led` | Non-gaming 40%+ of value and at least $200 paid |
| `app_dormant` | Linked app account, no app activity in 90 days |
| `top_value_no_app` | Top M quintile, no linked app account |
| `active_unreachable` | Active, but no channel we may market on |

Add or change one by editing `cdp.segment` (the rule is a SQL condition on `cdp.player_profile`), then run `REFRESH_ONLY=1 scripts/build-cdp.sh`. To keep the change for good, put it in `001_cdp.sql`. `v_segment_summary` shows each segment's size and how many members each channel reaches.

## Checks

[tests/cdp_checks.sql](tests/cdp_checks.sql), read-only, run by the build script:
- Every WinStar and mock source row arrives with the same theo, and every non-gaming row arrives.
- Profile and site-summary theo and non-gaming totals equal the activity in the window.
- Email matches only fill records that had no card number.
- RFM scores are 1–5 and only for active players. The home site is one of the sites the player visited.
- Self-excluded players are never reachable, and reachable always means a contact on file plus an opt-in.
- Every segment's members meet its rule, with nobody missing and nobody self-excluded.

## Known limits

- **WinStar is under-represented.** The sample holds one trip per account, while mocked sites have each player's full 13 months. Today Riverwind shows more theo than WinStar; a full WinStar load would reverse that.
- **Sampling gap:** 12,059 accounts have real WinStar play but no row in the patron master sample, so they appear in activity but not in profiles.
- **Mixed rows:** WinStar `A` rows mix slots and tables, so slot theo share understates slots for those players.
- **Mailing address** means a non-blank zip in the patron master, which is masked in dev.
- **Placeholders:** everything marked mock in `cdp.feed` is a stand-in; see the mock README for the values to correct.
