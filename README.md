# Sno/King Food Safety

A public web map of restaurant food-safety inspection ratings across **King** and
**Snohomish** counties, WA — live at **[food.snoking.app](https://food.snoking.app)**.

The two counties publish inspection data in completely different shapes (and one of
them doesn't publish it at all). This normalizes both onto a single 1–4 rating so
they can sit on the same map without the comparison being a lie.

```
   data sources                        ingester (Node)               Cloudflare
 ┌────────────────────────┐          ┌────────────────────┐        ┌──────────────────────────┐
 │ King Co. ArcGIS (EPL)  │──────────▶ ingest/ingest.mjs  │        │  Worker (src/index.js)   │
 │  business/inspection/  │          │  • merge permits   │──POST──▶  /ingest        (Bearer) │
 │  violation layers      │          │  • geocode (Sno)   │        │  /reconcile-... (Bearer) │
 │                        │          │  • King rubric ──▶ │        │                          │
 │ Snohomish Envision-    │──scrape──▶    scores Sno too  │        │  /              map      │
 │  Connect portal (PA1)  │          │  • normalize 1–4   │        │  /api/*         JSON     │
 └────────────────────────┘          └────────────────────┘        │  /r/<id>, /browse  SEO   │
                                                                   │      │                   │
                                                                   │  D1 + KV snapshot + AE   │
                                                                   └──────────────────────────┘
```

## Rating model

Both counties are normalized to a unified 1–4 rating (1 = best/green, 4 = worst/red).
The popup always shows the county's *native* metric too, so nothing is hidden.

| Rating | Label            | Color |
|-------:|------------------|-------|
| 1      | Excellent        | green |
| 2      | Good             | yellow |
| 3      | Okay             | orange |
| 4      | Needs to Improve | red   |

**King County** grades most restaurants itself, and we display that published grade
verbatim — we don't recompute it. (This is why a place can read "Excellent" while its
most recent inspection was Unsatisfactory: King's grade is a rolling average over
several inspections, not a snapshot of the last one.)

**Everything King doesn't grade** — schools, institutions, and *all* of Snohomish —
is scored King's way instead of being left blank or scored on a different scale.
Both counties inspect against the same WA Retail Food Code (WAC 246-215), and both
carry the WA item number in the violation text (King `0600 Adequate handwashing`,
Snohomish `06 - Adequate handwashing`). So `ingest/king-rubric.mjs` builds an item →
(critical?, points) map from King's own data, then scores everyone the same way King
does: **average critical (RED) points over the last 4 routine inspections**, against
cutoffs derived from King's actual grade distribution. The rubric is rebuilt from
live King data on every full run and cached in `ingest/king_violation_map.json`.

### Sources

- **King County** — [EPL_BusinessPoint ArcGIS FeatureServer](https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/EPL_BusinessPoint/FeatureServer)
  (layer 0 businesses, 1 inspections, 2 violations). Points come from the layer
  *geometry* — the `*_Lat`/`*_Lon` attribute columns are always null.
  King's [official rating system](https://kingcounty.gov/en/dept/dph/health-safety/food-safety/inspection-rating-system).
  > The old Socrata dataset (`f29f-zza5`) is no longer usable — it now returns
  > `"You must be logged in to access this resource"` and is frozen at 2025-11.
  > EPL history only reaches back to ~2022, so the ingester preserves the deeper
  > "in operation since" date and prior cuisine classifications by harvesting the
  > live API before re-keying to `Business_Record_ID`.
- **Snohomish County** — the Health Department's
  [EnvisionConnect portal](https://snohomishonline.envisionconnect.com/#/pa1/search)
  has no open-data feed, so the ingester drives its `searchFacilities` API
  (recursive name-prefix expansion to beat the 50-result cap) and geocodes street
  addresses via the US Census batch geocoder, with a Google fallback for addresses
  Census can't match. Cached in `ingest/geocache.json`.

## What's on the site

- **Map** — clustered Leaflet markers, filters by rating / county / cuisine, search.
- **`/r/<id>`** — a crawlable page per establishment (rating, violations, history),
  with **`/browse`** as the county → city → restaurant crawl path, plus `/sitemap.xml`.
- **Bloopers** (`/bloopers`) — the genuinely alarming violations, names redacted.
- **Push notifications** — favorite a restaurant, get notified when its rating changes
  (Web Push / VAPID; dispatched after each ingest).
- **Region stats** — ratings aggregated by census tract (`regions/tracts.geojson`).
- **`/dashboard`** — token-gated usage stats from Analytics Engine (anonymous, no PII).
- **`/mcp`** — a hosted [MCP](https://modelcontextprotocol.io) server (Streamable HTTP, no auth),
  so AI assistants can search establishments and pull inspection histories directly.
- Installable PWA (service worker, offline shell).

## Handling businesses that go missing

A place can vanish from a county feed for reasons that mean very different things, and
conflating them puts wrong information on a public map. After a full crawl,
`/reconcile-delisted` splits them three ways:

| Cause | Treatment |
|---|---|
| **Absorbed** by the permit merge — a grocery's deli/bakery/meat permits collapsing into one pin, where the surviving id changed | Delete the orphan row immediately and re-point any favorites at the survivor. The business is open; this row is just a duplicate pin frozen at an old rating. |
| **Still listed as open** by the county, but dropped by *our* filters (no usable rating, missing coordinates) | Leave it alone. "Closed" is a claim the source data contradicts. |
| **Actually gone** from the county feed | Mark delisted — a "Closed" badge, keeping the last known rating — and delete after 6 months continuously missing. Reappearing clears the flag. |

Two guards keep a bad crawl from doing damage: the reconciler refuses to run if the
live set covers less than 70% of stored rows, and it skips the delete sweep if the
merge suddenly claims to absorb more than 10% of the county. `--reconcile-dry`
reports the full classification without writing anything.

A known upstream limitation: when a restaurant changes hands, the health permit often
keeps the old name until the county processes the change, so the map shows the old
name with the *new* kitchen's inspections. That's the county's record, faithfully
displayed — the ratings are current even when the name isn't.

## Components

| Path | What it is |
|---|---|
| `src/index.js` | The whole Worker — map UI, all HTML pages, `/api/*`, ingest + admin endpoints |
| `src/webpush.js` | VAPID signing / Web Push delivery |
| `src/mcp.js` | The `/mcp` MCP server — hand-rolled Streamable HTTP, three read-only tools over D1 |
| `schema.sql` | D1: `establishments`, `bloopers`, `push_subs`, `push_favorites` |
| `ingest/ingest.mjs` | Pulls both counties, merges, geocodes, scores, POSTs |
| `ingest/README.md` | Per-file guide to the ingest directory — what each tool does, what reads it, what needs credentials |
| `ingest/king-rubric.mjs` | The shared WA-item rubric that lets Snohomish be scored King-style |
| `ingest/cuisine.mjs` | Name → cuisine classifier (with curated overrides in `*_reclass.json`) |
| `ingest/snapshot-cuisine.mjs` | Writes + reads `cuisine_snapshot.json`, the disaster-recovery copy of the curated cuisines |
| `ingest/bloopers.mjs` | Picks + redacts the blooper-worthy violations |
| `ingest/regions.mjs` | Census-tract tagging |
| `public/` | Static assets served straight from the edge (never invoke the Worker) |

## Deploy

```sh
npx wrangler d1 execute snoking-foodsafety --remote --file schema.sql
npx wrangler kv namespace create REGIONS        # then put the id in wrangler.toml

npx wrangler secret put INGEST_TOKEN            # any random string; the ingester uses the same
npx wrangler secret put DASH_TOKEN              # gates /dashboard
npx wrangler secret put GOOGLE_KEY              # optional — Street View is hidden without it
npx wrangler secret put AE_API_TOKEN            # optional — scoped "Account Analytics Read" token
npx wrangler secret put VAPID_PRIVATE_JWK       # optional — push notifications

npx wrangler deploy
```

`wrangler.toml` holds only non-secret config (the public VAPID key, D1/KV binding ids,
account id). Every credential is a Worker secret or a GitHub Actions secret.

## Refresh the data

```sh
cd ingest
# WORKER_URL + INGEST_TOKEN via env or ingest/config.json (gitignored)
node ingest.mjs                  # full run, posts to the Worker
node ingest.mjs --dry            # write data.json locally, don't post (no token needed)
node ingest.mjs --king-only      # skip the slow Snohomish crawl (also --sno-only)
node ingest.mjs --reconcile-dry  # push data, but only *report* what reconciliation would remove
node ingest.mjs --no-geocode     # skip Snohomish geocoding (debug)
node ingest.mjs --limit=200      # Snohomish: crawl only the first N facilities (debug)
```

Re-running upserts in place (idempotent on the establishment id), so it's safe to run
on a schedule. Two GitHub Actions handle that:

- **`ingest.yml`** — Mondays 17:00 UTC full refresh; other days a fast King-only run.
  King is reconciled every run (it's always fetched in full); Snohomish only on the
  full run. Afterwards it dispatches favorite-change push notifications and pings
  IndexNow.
- **`deploy.yml`** — deploys the Worker on push to `main` touching `src/**` or
  `wrangler.toml`.

### Rebuilding after losing D1

Almost everything is re-derivable from the counties on the next run. The one thing
that isn't is the ~3,300 hand-corrected cuisine classifications — the ones the
keyword classifier gets wrong and a human fixed. For King those were only ever kept
alive by each run harvesting the *previous* run's live API, which is a loop with no
file at the bottom of it. (The id-keyed `*_reclass.json` overrides don't cover it:
King's ids migrated from Socrata `king:PR0083278` to ArcGIS `king:PFE-PR-3134122`,
so those files silently stopped matching.)

`ingest/cuisine_snapshot.json` is the copy that survives. It's keyed by **name +
address**, not by id — the same join the harvest uses, and the one that survived the
id migration that an id-keyed file did not. Only entries that *differ* from
`cuisineOf(name)` are stored, since the rest is reproducible from code. The ingester
consults it only when the live carry-forward misses, so a normal run is unaffected;
on a cold rebuild it's the difference between restoring the curation and quietly
falling back to "Other".

```sh
cd ingest
node snapshot-cuisine.mjs --dry   # report what would change against the live site
node snapshot-cuisine.mjs         # rewrite cuisine_snapshot.json, then commit it
```

Worth re-running (and committing) after any batch of cuisine re-classification. It
refuses to write from a payload under 5,000 establishments and warns if it would drop
more than 10% of the existing entries, so a half-built site can't erase the file.

## Caveats

If a restaurant looks wrong on the map, check the county's own record first — most
discrepancies (stale names, missing establishments) originate upstream and can't be
fixed here.

> Data is sourced from county health-department records and may lag the most recent
> on-site inspection. Ratings are a normalization, not an official grade — for
> Snohomish especially, the 1–4 rating is *our* King-style scoring, not something the
> county publishes. Always confirm via the linked official report.

## License

Code is [MIT](LICENSE).

The data is not mine to license: inspection records are public records belonging to
[Public Health – Seattle & King County](https://kingcounty.gov/en/dept/dph) and the
[Snohomish Health Department](https://snohomishcountywa.gov/5171/Health-Department),
and `regions/tracts.geojson` is US Census TIGER/Line data (public domain). If you
reuse any of it, cite the counties rather than this repo.
