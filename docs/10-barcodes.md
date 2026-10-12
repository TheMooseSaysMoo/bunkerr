# Barcode lookups

When you scan a barcode, Bunkerr fills in the name, brand, size, category and, for most groceries, **calories per package**, so the dashboard's *days of food* estimate grows as you scan. Most groceries resolve from a local copy of the public databases, so scanning keeps working with the internet down.

## Lookup order

| # | Source | Where | Notes |
|---|---|---|---|
| 1 | Your household's past entries | local | your own name, unit, location and calories win |
| 2 | **USDA FoodData Central**, branded foods | local copy | about 430k US groceries from label data. Public domain. Best calorie source |
| 2 | **Open Food Facts**, US products | local copy | about 890k products, typed in by volunteers, with photos. ODbL |
| 3 | Open Food Facts (worldwide) | online | newer or non-US products |
| 3 | Open Products / Beauty / Pet Food Facts | online | batteries, household goods, toiletries, pet food |
| 4 | UPCitemdb free tier | online | general merchandise. Asked only when every open database answered "unknown". About 100 lookups a day |

When a product is in both local sources, Bunkerr uses Open Food Facts' name and photo and USDA's calories. Online answers, including "not found", are cached: hits for 30 days, misses for a day. If the internet is down, online lookups give up after about 4 seconds, and nothing is cached, so the next scan tries again.

The scan card shows where an answer came from, and whether it came from the offline copy.

## Calories

The local sources give energy per 100 g and the package size. Bunkerr multiplies them into **kcal per unit** (one package), which feeds the *days of food* figure. If you count something differently, for example by the can when a case was scanned, open *more* on the form and correct it once. Your correction is remembered for that barcode.

## The offline copy

- It lives in `data/barcodes.db` (about 140 MB), separate from `bunkerr.db`. Snapshots, standby sync and daily backups stay small. If it's deleted, it rebuilds.
- Each instance builds its own copy, including a failover standby, so scanning still works offline after a failover.
- Nightly at 02:20 it checks the sources. USDA is re-imported when a new release appears (about twice a year). Open Food Facts is re-imported monthly. A full rebuild downloads about 1.5 GB and takes a couple of minutes. Lookups keep working throughout, and a failed or empty download leaves the previous copy in place.
- **Settings → instance admin → offline barcode database** shows row counts, release dates and errors, and has *refresh now* buttons.
- From a shell, including on the standby: `docker exec bunkerr node server/dist/cli.js barcodes-refresh [usda|off] [--if-due]`. This is safe while the app is running.

### Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `BARCODE_MIRROR` | `on` | `off` stops downloads and the local copy |
| `BARCODE_COUNTRIES` | `en:united-states` | Open Food Facts countries to keep, comma-separated (e.g. `en:united-states,en:canada`), or `all` (about 4M products, roughly 600 MB) |
| `BARCODE_ONLINE` | `on` | `off` never asks the online databases |
| `UPCITEMDB` | `on` | `off` skips the UPCitemdb fallback |

## Licences

USDA FoodData Central is public domain. Open Food Facts data is © Open Food Facts contributors, under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Bunkerr uses it privately and doesn't redistribute it. UPCitemdb's free tier is a commercial service with a daily limit.
