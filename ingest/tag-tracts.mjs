#!/usr/bin/env node
// Assign each establishment to its census tract (point-in-polygon) and push the
// tract_id to the Worker — backfills the stats choropleth without a re-ingest.
//   node tag-tracts.mjs        # update the Worker
//   node tag-tracts.mjs --dry  # just print coverage
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTagger } from "./regions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
function cfg(k, d) { if (process.env[k]) return process.env[k];
  try { const c = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")); if (c[k]) return c[k]; } catch {} return d; }
const WORKER_URL = cfg("WORKER_URL", "https://snoking-foodsafety.3lemenopy.workers.dev").replace(/\/$/, "");
const INGEST_TOKEN = cfg("INGEST_TOKEN", "");

const tag = loadTagger();
const j = await (await fetch(WORKER_URL + "/api/establishments")).json();
const items = j.items || [];
const updates = items.map((d) => ({ id: d.id, tract_id: tag(d.lo, d.la) }));
const tagged = updates.filter((u) => u.tract_id).length;
console.log(`tagged ${tagged}/${updates.length} into tracts (${updates.length - tagged} outside / unmatched)`);
if (DRY) process.exit(0);
if (!INGEST_TOKEN) { console.error("No INGEST_TOKEN"); process.exit(1); }

let n = 0;
for (let i = 0; i < updates.length; i += 500) {
  const batch = updates.slice(i, i + 500);
  const r = await fetch(WORKER_URL + "/set-tract", { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + INGEST_TOKEN }, body: JSON.stringify(batch) });
  if (!r.ok) { console.error("set-tract", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
  n += batch.length; process.stdout.write(`  updated ${n}/${updates.length}\r`);
}
console.log(`\ntagged ${n} establishments`);
