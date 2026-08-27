#!/usr/bin/env node
// Recompute cuisine from each establishment's name and push only the cuisine column
// (via the Worker's /set-cuisine), so classification can be iterated without a full
// re-ingest or the slow Snohomish crawl.
//   node reclassify.mjs        # update the Worker
//   node reclassify.mjs --dry  # just print the distribution
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cuisineOf, CUISINE_LABELS } from "./cuisine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
function cfg(k, d) { if (process.env[k]) return process.env[k];
  try { const c = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")); if (c[k]) return c[k]; } catch {} return d; }
const WORKER_URL = cfg("WORKER_URL", "https://snoking-foodsafety.3lemenopy.workers.dev").replace(/\/$/, "");
const INGEST_TOKEN = cfg("INGEST_TOKEN", "");

const j = await (await fetch(WORKER_URL + "/api/establishments")).json();
const items = j.items || [];
// mb = county-declared mobile unit: always "foodtruck" (set at ingest from the county's own
// category field, which a name-based reclassify can't see) — skip so we don't clobber it
const updates = items.filter((d) => !d.mb).map((d) => ({ id: d.id, cuisine: cuisineOf(d.n) }));
const dist = {}; updates.forEach((u) => (dist[u.cuisine] = (dist[u.cuisine] || 0) + 1));
console.log("cuisine distribution:");
Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("  " + (CUISINE_LABELS[k] || k).padEnd(18), v));
console.log("total:", updates.length);
if (DRY) process.exit(0);
if (!INGEST_TOKEN) { console.error("No INGEST_TOKEN"); process.exit(1); }

let n = 0;
for (let i = 0; i < updates.length; i += 500) {
  const batch = updates.slice(i, i + 500);
  const r = await fetch(WORKER_URL + "/set-cuisine", { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + INGEST_TOKEN }, body: JSON.stringify(batch) });
  if (!r.ok) { console.error("set-cuisine", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
  n += batch.length; process.stdout.write(`  updated ${n}/${updates.length}\r`);
}
console.log(`\nreclassified ${n} establishments`);
