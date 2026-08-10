// Snapshot the curated cuisine classifications to a file, so they survive losing D1.
//
// Cuisine comes from three places: the keyword classifier in cuisine.mjs (reproducible from
// code), the curated *_reclass.json overrides (keyed by establishment id), and — for King —
// whatever the previous run stored, carried forward by harvestKing(). That last path is the
// problem: it re-reads the LIVE API each run, so King's curation is a self-referential loop
// that exists only in D1. It also can't be restored from the reclass files, whose King ids are
// pre-ArcGIS (`king:PR0083278`) and no longer resolve.
//
// So key the snapshot by NAME + ADDRESS instead of by id — the same join harvestKing() uses.
// That survives another id migration, which an id-keyed file demonstrably did not.
//
// Only entries that DIFFER from cuisineOf(name) are stored; the rest is reproducible from code,
// and leaving it out keeps the file to what's actually irreplaceable.
//
//   node snapshot-cuisine.mjs           # rewrite cuisine_snapshot.json from the live site
//   node snapshot-cuisine.mjs --dry     # report what would change, write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cuisineOf } from "./cuisine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "cuisine_snapshot.json");
const DRY = process.argv.includes("--dry");
const SITE = process.env.SITE_URL || "https://food.snoking.app";

export const ckey = (name, addr) =>
  String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim() + "|" +
  String(addr || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

// ── read side: what ingest.mjs calls ─────────────────────────────────────────
// Kept here rather than in ingest.mjs so the lookup can be imported and tested without importing
// ingest.mjs, which runs a full ingest on import.
const CSNAP = (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return {}; } })();
// Secondary index on name + street number, mirroring harvestKing()'s fallback: unit suffixes drift
// between the source record and the merged one we store ("1901 RAINIER AVE S, 2" vs "1901 RAINIER
// AVE S"), which would otherwise miss. Ambiguous street numbers are dropped rather than guessed.
const CSNAP_NUM = (() => {
  const idx = new Map(), dupe = new Set();
  for (const [k, v] of Object.entries(CSNAP)) {
    const [n, a] = k.split("|"), m = /^\s*(\d+)/.exec(a || "");
    if (!m) continue;
    const nk = n + "#" + m[1];
    if (idx.has(nk) && idx.get(nk) !== v) dupe.add(nk); else idx.set(nk, v);
  }
  for (const d of dupe) idx.delete(d);   // same name+number, two cuisines -> can't disambiguate
  return idx;
})();
export function snapCuisine(name, addr) {
  const k = ckey(name, addr);
  if (CSNAP[k]) return CSNAP[k];
  const [n, a] = k.split("|"), m = /^\s*(\d+)/.exec(a || "");
  return (m && CSNAP_NUM.get(n + "#" + m[1])) || null;
}

// ── write side: only when run directly ───────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await fetch(`${SITE}/api/establishments?cb=${Date.now()}`);
  if (!r.ok) throw new Error(`GET /api/establishments -> HTTP ${r.status}`);
  const raw = await r.json();
  const items = Array.isArray(raw) ? raw : raw.items || [];
  if (items.length < 5000) throw new Error(`only ${items.length} establishments — refusing to snapshot a partial payload`);

  const snap = {}, conflicts = [];
  let skippedDerivable = 0;
  for (const x of items) {
    if (!x.cu || x.cu === cuisineOf(x.n)) { skippedDerivable++; continue; }   // reproducible from code
    const k = ckey(x.n, x.a);
    if (snap[k] && snap[k] !== x.cu) conflicts.push(`${k}: ${snap[k]} vs ${x.cu}`);
    snap[k] = x.cu;   // last write wins; conflicts are reported below
  }

  let prev = {};
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
  const added = Object.keys(snap).filter((k) => !(k in prev));
  const removed = Object.keys(prev).filter((k) => !(k in snap));
  const changed = Object.keys(snap).filter((k) => k in prev && prev[k] !== snap[k]);

  console.log(`${items.length} establishments -> ${Object.keys(snap).length} curated entries ` +
    `(${skippedDerivable} reproducible from cuisine.mjs, not stored)`);
  console.log(`  vs existing snapshot: +${added.length} added, ~${changed.length} changed, -${removed.length} removed`);
  if (conflicts.length) console.log(`  ${conflicts.length} name+address collisions with differing cuisine:\n    ` + conflicts.slice(0, 10).join("\n    "));
  // A big drop usually means the live payload was mid-rebuild, not that curation vanished.
  if (removed.length > Object.keys(prev).length * 0.1)
    console.log(`  WARNING: losing ${removed.length} entries (>10%) — check the site is healthy before committing this`);

  if (DRY) { console.log("(dry — nothing written)"); }
  else {
    const sorted = Object.fromEntries(Object.keys(snap).sort().map((k) => [k, snap[k]]));   // stable order = readable diffs
    writeFileSync(OUT, JSON.stringify(sorted, null, 0));
    console.log(`wrote ${OUT}`);
  }
}
