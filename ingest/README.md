# `ingest/` — what each file is for

The ingester pulls both counties, normalizes them onto one 1–4 rating, and POSTs the
result to the Worker. Only **two** scripts here run on a schedule; everything else is
either a module they import, a data file they read, or a hand-run maintenance tool.

```
  ingest.mjs ──imports──▶ cuisine.mjs · snapshot-cuisine.mjs · king-rubric.mjs
      │                   bloopers.mjs · regions.mjs
      │
      ├──reads──▶ cuisine_snapshot.json · places_reclass*.json · coord_overrides.json
      │           bloopers_keep.json · king_violation_map.json · geocache.json
      │
      └──POST───▶ Worker /ingest · /reconcile-delisted
```

## Runs in CI

| File | When | Notes |
|---|---|---|
| `ingest.mjs` | `ingest.yml` — Mondays full, other days `--king-only` | The entry point. Everything below is in service of it. |
| `indexnow-submit.mjs` | after each ingest | Pings IndexNow (Bing/Yandex) with the sitemap URLs. Re-runnable anytime. |

`ingest.mjs` flags: `--dry` (write `data.json`, don't POST — no token needed),
`--king-only` / `--sno-only`, `--reconcile-dry` (push data but only *report* what
reconciliation would remove), `--no-geocode`, `--limit=N` (Snohomish debug).

## Modules — imported, never run directly

| File | Exports | Used by |
|---|---|---|
| `cuisine.mjs` | `cuisineOf(name)`, `CUISINE_LABELS` | `ingest.mjs`, `snapshot-cuisine.mjs`, `places2.mjs`, `reclassify.mjs` |
| `snapshot-cuisine.mjs` | `snapCuisine(name, addr)`, `ckey()` | `ingest.mjs` — **also runnable directly** to rewrite `cuisine_snapshot.json` |
| `king-rubric.mjs` | `buildKingRubric`, `ratingKingStyle`, `tagViols`, `riskN`, `critPoints`, `item2` | `ingest.mjs` — the shared WA-item rubric that lets Snohomish be scored King-style |
| `bloopers.mjs` | `blooperTag`, `blooperText`, `redactName` | `ingest.mjs` |
| `regions.mjs` | `loadTagger(path)` | `ingest.mjs`, `tag-tracts.mjs` — point-in-polygon over `regions/tracts.geojson` (670 tracts), bbox-prefiltered |

## Committed data — the irreplaceable part

These are the files a fresh clone genuinely needs. Everything else regenerates from the
counties on the next run.

| File | Written by | Read by | What it holds |
|---|---|---|---|
| `cuisine_snapshot.json` | `snapshot-cuisine.mjs` | `ingest.mjs` | 3,315 curated cuisines the name-classifier gets wrong, keyed by **name + address**. The disaster-recovery copy — restores 3,010/3,010 non-derivable King cuisines from an empty D1. Only entries differing from `cuisineOf(name)` are stored. |
| `coord_overrides.json` | `fix-sno-coords-google.mjs` | `ingest.mjs` | 1,926 Snohomish pins where the Census geocoder interpolated onto the wrong street. All still resolve. |
| `places_reclass.json` | `places.mjs` | `ingest.mjs` | 280 Snohomish cuisine overrides from Google Places. |
| `places_reclass2.json` | `places2.mjs` | `ingest.mjs` | 133 second-pass overrides (King + Sno), written after the id migration — all resolve. |
| `bloopers_keep.json` | hand-curated | `ingest.mjs` | 181 ids: the "actually funny" blooper allow-list. Empty or missing ⇒ no filtering. |
| `bloopers_keep.txt` | hand-curated | *nothing* | Human-readable sidecar recording *why* each id is kept. Currently lists 189 — the `.json` is authoritative when they disagree. |
| `king_violation_map.json` | `ingest.mjs` | `ingest.mjs` | Cached King rubric (51 items + grade cutoffs). Rebuilt from live King data on every full run; committed so a King-only or offline run still has it. |

## Manual tools — not on any schedule, but all still work

None of these are referenced by another file. They operate on the **deployed** site, so
they're the way to fix something without waiting for a full re-ingest (the Snohomish
crawl is the slow part). Every Worker endpoint they call still exists.

| Tool | Does | Endpoint |
|---|---|---|
| `places.mjs` | Looks up establishments classified "Other" via Google Places Text Search, maps `primaryType` → our cuisines. Writes `places_reclass.json`. | reads `/api/establishments` |
| `places2.mjs` | Second pass over what's *still* "Other": full `types[]` + `editorialSummary` + keyword fallback. Writes `places_reclass2.json`. | reads `/api/establishments` |
| `reclassify.mjs` | Recomputes cuisine from names and pushes only that column — iterate the classifier without a re-ingest. `--dry` prints the distribution. | `/set-cuisine` |
| `tag-tracts.mjs` | Backfills `tract_id` (point-in-polygon) for the stats choropleth. `--dry` prints coverage. | `/set-tract` |
| `fix-sno-coords-google.mjs` | Re-geocodes Snohomish via Google; where a ROOFTOP result differs from the stored Census point past a threshold, corrects it. Writes D1 directly via `wrangler d1 execute` **and** merges into `coord_overrides.json`. | Google Geocoding |
| `build-diversity.mjs` | Adds ACS5 population + a Gini-Simpson diversity index to `regions/tracts.geojson`. Re-upload to KV afterward. | Census ACS |

Credentials, from `config.json` or env (env wins): `GOOGLE_KEY` for `places.mjs`,
`places2.mjs`, `fix-sno-coords-google.mjs`; `INGEST_TOKEN` for `reclassify.mjs` and
`tag-tracts.mjs`, the two that POST to the Worker. `fix-sno-coords-google.mjs` needs
neither a token nor the Worker — it goes through `wrangler`, so it needs your Cloudflare
login instead. `build-diversity.mjs` needs nothing.

## Not committed (gitignored)

| File | What |
|---|---|
| `config.json` | `WORKER_URL`, `INGEST_TOKEN`, `GOOGLE_KEY`, `DASH_TOKEN`. Env vars take precedence. **Never commit.** |
| `geocache.json` | Snohomish address → lat/lon cache. Rebuildable, but slow and burns API quota. |
| `programs.json` | Snohomish `FacilityId` → `{programId, category}` cache. |
| `data.json`, `bloopers.json` | Last run's output (`--dry` writes these instead of POSTing). |
| `.indexnow-key`, `*.log`, `reconcile-dry-*.json` | Local scratch. |

## One thing to know before adding an override file

**Don't key new curation by establishment id.** King's ids migrated from Socrata
(`king:PR0083278`) to ArcGIS (`king:PFE-PR-3134122`), which silently zeroed out every
King row in the override files written before it — 2,425 rows that stored only
`{id, cuisine}`, with no name or address to re-key them by. They kept loading without
error and matching nothing. Those rows have since been deleted.

`cuisine_snapshot.json` is keyed by name + address precisely because that join survived
the migration and an id-keyed one demonstrably did not. If you add curation, prefer that
shape, and re-run `node snapshot-cuisine.mjs` afterward so it lands in the file that can
actually restore it:

```sh
node snapshot-cuisine.mjs --dry   # report what would change vs the live site
node snapshot-cuisine.mjs         # rewrite cuisine_snapshot.json, then commit it
```

It refuses to write from a payload under 5,000 establishments and warns if it would drop
more than 10% of existing entries, so a half-built site can't erase the file.
