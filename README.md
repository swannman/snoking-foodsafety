# SnoKing Food Safety

A public web map of the latest restaurant food-safety inspection ratings across
**King** and **Snohomish** counties, served from a Cloudflare Worker + D1, fed by
an external ingester that pulls each county's source and normalizes both to one
1–4 rating scale.

```
   data sources                       ingester (Node)              Cloudflare
 ┌───────────────────────┐          ┌──────────────────┐        ┌────────────────────────┐
 │ King Co. Socrata API  │──────────▶ ingest/ingest.mjs │        │ Worker (src/index.js)  │
 │  f29f-zza5 (has coords)│          │  • latest/biz     │──POST──▶  POST /ingest (Bearer) │
 │ Snohomish EnvisionConn │──scrape──▶  • geocode (Sno)  │  /ingest  GET  /  (map)        │
 │  searchFacilities (PA1) │          │  • normalize 1–4 │        │  GET  /api/establishments│
 └───────────────────────┘          └──────────────────┘        │      │                  │
                                                                 │    D1 (establishments)  │
                                                                 └────────────────────────┘
```

## Rating model

Both counties are normalized to a unified 1–4 rating (1 = best/green, 4 = worst/red);
the popup always shows the county's *native* metric too, so nothing is hidden.

| Rating | Label             | King County (official grade) | Snohomish (violation points) |
|-------:|-------------------|------------------------------|------------------------------|
| 1      | Excellent         | grade 1                      | 0 pts                        |
| 2      | Good              | grade 2                      | 1–15 pts                     |
| 3      | Okay              | grade 3                      | 16–35 pts                    |
| 4      | Needs to Improve  | grade 4                      | 36+ pts                      |

- **King County** — [Public Health – Seattle & King County food inspection data](https://data.kingcounty.gov/Health-Wellness/Food-Establishment-Inspection-Data/f29f-zza5)
  (Socrata). Already geolocated; uses the county's [official rating system](https://kingcounty.gov/en/dept/dph/health-safety/food-safety/inspection-rating-system).
- **Snohomish County** — the Health Department's [EnvisionConnect portal](https://snohomishonline.envisionconnect.com/#/pa1/search)
  has no open data feed, so the ingester drives its `searchFacilities` API
  (recursive name-prefix expansion to beat the 50-result cap) and geocodes the
  street addresses via the US Census batch geocoder (cached in `ingest/geocache.json`).

## Components

- **`src/index.js`** — the Worker: the Leaflet map (clustered markers, rating/county
  filters, search), `/api/establishments` (reads D1), and the Bearer-authed `/ingest`.
- **`schema.sql`** — D1 `establishments` table (one row per place, upserted on re-ingest).
- **`ingest/ingest.mjs`** — pulls both counties, geocodes Snohomish, POSTs to `/ingest`.

## Deploy

```sh
npx wrangler d1 execute snoking-foodsafety --remote --file schema.sql
npx wrangler secret put INGEST_TOKEN        # any random string; the ingester uses the same
npx wrangler deploy
```

## Refresh the data

```sh
cd ingest
# WORKER_URL + INGEST_TOKEN via env or ingest/config.json
node ingest.mjs            # full run, posts to the Worker
node ingest.mjs --dry      # write data.json locally, don't post
```

Re-running upserts in place (idempotent on the establishment id), so it's safe to
run on a schedule (cron / GitHub Action) to keep ratings current.

> Data is sourced from county health-department records and may lag the most recent
> on-site inspection. Always confirm via the linked official report.
