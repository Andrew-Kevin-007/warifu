# Pilot tracker

`pilot_tracker.csv` has one row per pilot. It is committed header-only: **no row is ever invented**. Rows are added only for real contacts (spec: `docs/09` §7). The file is private working data; it holds handles and wallet addresses, so keep it out of public surfaces unless `consent_publish=Y`.

Check it with `node scripts/pilot-tracker-check.mjs` (also runs in `pnpm test`).

| Column | Rule |
|---|---|
| `pilot_id` | unique, e.g. `P-001` |
| `name_handle` | person or handle (free text) |
| `segment` | `S1`..`S6` (`S6` = challenge participants, prospects only) |
| `channel` | free text (discord, telegram, email, ...) |
| `first_contact_at`, `last_event_at` | ISO-8601 date or datetime (`last_event_at` may be empty) |
| `stage` | `CONTACTED`, `REPLIED`, `CALL_SCHEDULED`, `ONBOARDED`, `FIRST_INVOICE`, `FIRST_RELEASE`, `REPEAT` |
| `network` | `testnet`, `mainnet` or empty; **never blended in one row** |
| `owner_wallet` | `0x` + 40 hex, or empty; required from `ONBOARDED` onward |
| `payees_count`, `engagements_created`, `invoices_processed`, `real_payments` | non-negative integers |
| `value_base_units` | non-negative integer, **base units** (bigint-safe; no decimals, no floats) |
| `consent_publish` | `Y` or `N` |
| `testimonial` | `N`, or `Y: <quote>`; `Y` requires `consent_publish=Y` |
| `notes` | free text; mark flows between wallets Kevin controls with `internal` |

Consistency rules the checker enforces: stages that imply activity need the matching counts (`FIRST_INVOICE` ⇒ `invoices_processed ≥ 1`; `FIRST_RELEASE`/`REPEAT` ⇒ `real_payments ≥ 1`; `REPEAT` ⇒ `real_payments ≥ 2`); `real_payments > 0` or `value_base_units > 0` needs a `network`; rows tagged `internal` in `notes` may not carry `real_payments > 0`; segment `S6` cannot reach `ONBOARDED` (it must be re-segmented once a real engagement exists).
