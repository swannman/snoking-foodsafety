// One-off: re-insert curated bloopers that fell out of the live reel because their source
// restaurant left the Snohomish feed (e.g. closed). Reconstructs them from bloopers_keep.txt
// and upserts via /ingest-bloopers. Pair with the pushBloopers persistence change so it doesn't recur.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { blooperTag, redactName } from "./bloopers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = (k) => JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"))[k];
const INGEST_TOKEN = cfg("INGEST_TOKEN");
const WORKER_URL = "https://snoking-foodsafety.3lemenopy.workers.dev";
const SNO_BASE = "https://snohomishonline.envisionconnect.com";

// parse the human-readable keep-list into {id -> {name, city, label, text}}
const lines = readFileSync(join(HERE, "bloopers_keep.txt"), "utf8").split(/\r?\n/);
const byId = {};
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  // ID line (no indent, has a colon) followed by an indented "<emoji> NAME (CITY) — label" line
  if (/^\S/.test(l) && l.includes(":") && /\(.+\)\s*—/.test(lines[i + 1] || "")) {
    const id = l.trim();
    const mm = /^\s*\S+\s+(.+?)\s*\((.+?)\)\s*—\s*(.+?)\s*$/.exec(lines[i + 1] || "");
    const text = (lines[i + 2] || "").trim().replace(/^[“"]+/, "").replace(/[”"]+$/, "").trim();
    byId[id] = { name: mm ? mm[1].trim() : "", city: mm ? mm[2].trim() : "", label: mm ? mm[3].trim() : "", text };
  }
}
const keep = JSON.parse(readFileSync(join(HERE, "bloopers_keep.json"), "utf8"));
const existing = new Set(JSON.parse(execSync(`npx wrangler d1 execute snoking-foodsafety --remote --json --command "SELECT id FROM bloopers"`, { maxBuffer: 1 << 28 }))[0].results.map((r) => r.id));
const missing = keep.filter((id) => !existing.has(id));
console.log(`keep=${keep.length}, live=${existing.size}, missing=${missing.length}`);

const recs = [];
for (const id of missing) {
  const b = byId[id];
  if (!b || !b.text) { console.log("  no text for", id); continue; }
  recs.push({ id, name: b.name, city: b.city, date: null, tag: blooperTag(b.text) || "😅",
    label: b.label, text: redactName(b.text, b.name), report_url: SNO_BASE + "/#/pa1/detail/" + id.split(":")[0], lat: null, lon: null });
  console.log("  +", b.city, "|", b.text.slice(0, 60));
}
if (recs.length) {
  const r = await fetch(WORKER_URL + "/ingest-bloopers", { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + INGEST_TOKEN }, body: JSON.stringify(recs) });
  console.log("push:", r.status, (await r.text()).slice(0, 120));
} else console.log("nothing to recover");
