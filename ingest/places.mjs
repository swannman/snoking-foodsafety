#!/usr/bin/env node
// Look up "Other" establishments via Google Places (New) Text Search and map the
// returned primaryType -> our cuisine categories. Writes ingest/places_reclass.json.
//   node places.mjs --limit=200   # test batch
//   node places.mjs               # all "Other"
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find((x) => x.startsWith("--limit=")); return a ? parseInt(a.slice(8), 10) : 0; })();
function cfg(k, d) { if (process.env[k]) return process.env[k];
  try { const c = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")); if (c[k]) return c[k]; } catch {} return d; }
const KEY = cfg("GOOGLE_KEY", "");
const WORKER_URL = cfg("WORKER_URL", "https://snoking-foodsafety.3lemenopy.workers.dev").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google Places primaryType -> our cuisine category
const MAP = {
  pizza_restaurant: "pizza", mexican_restaurant: "mexican", taco_restaurant: "mexican",
  chinese_restaurant: "chinese", japanese_restaurant: "japanese", sushi_restaurant: "japanese", ramen_restaurant: "japanese",
  thai_restaurant: "thai", vietnamese_restaurant: "vietnamese", korean_restaurant: "korean", indian_restaurant: "indian",
  mediterranean_restaurant: "mediterranean", greek_restaurant: "mediterranean", lebanese_restaurant: "mediterranean",
  middle_eastern_restaurant: "mediterranean", turkish_restaurant: "mediterranean", afghani_restaurant: "mediterranean", spanish_restaurant: "mediterranean",
  italian_restaurant: "italian", barbecue_restaurant: "bbq", steak_house: "bbq",
  hamburger_restaurant: "burgers", fast_food_restaurant: "fastfood",
  sandwich_shop: "sandwich", deli: "sandwich", bagel_shop: "sandwich",
  seafood_restaurant: "seafood",
  cafe: "coffee", coffee_shop: "coffee", tea_house: "coffee", cafeteria: "coffee",
  bakery: "bakery", dessert_shop: "bakery", dessert_restaurant: "bakery", ice_cream_shop: "bakery", donut_shop: "bakery", chocolate_shop: "bakery", candy_store: "bakery",
  bar: "bar", pub: "bar", wine_bar: "bar", bar_and_grill: "bar",
  grocery_store: "grocery", supermarket: "grocery", convenience_store: "grocery", asian_grocery_store: "grocery", butcher_shop: "grocery", market: "grocery", food_store: "grocery", liquor_store: "grocery",
  asian_restaurant: "asian", indonesian_restaurant: "asian",
  american_restaurant: "american", breakfast_restaurant: "cafe_diner", brunch_restaurant: "cafe_diner", diner: "cafe_diner",
  // intentionally NOT mapped (left Other): restaurant, food, fine_dining_restaurant, vegan/vegetarian, french/brazilian/etc.
};

async function lookup(name, city) {
  const q = name + (city ? ", " + city : "") + ", WA";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "places.displayName,places.primaryType,places.formattedAddress" },
        body: JSON.stringify({ textQuery: q, maxResultCount: 1, regionCode: "US" }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.error) { if (i === 2) console.log("  places error:", j.error.status); return null; }
      const p = (j.places || [])[0];
      return p ? { type: p.primaryType, addr: p.formattedAddress, name: p.displayName?.text } : null;
    } catch (e) { if (i === 2) return null; await sleep(500 * (i + 1)); }
  }
  return null;
}

const j = await (await fetch(WORKER_URL + "/api/establishments")).json();
let other = j.items.filter((x) => x.cu === "other");
if (LIMIT) { other = other.slice().sort(() => 0.5 - Math.random()).slice(0, LIMIT); }   // representative sample
console.log(`looking up ${other.length} "Other" establishments via Google Places…`);

const out = [], dist = {}; let done = 0, matched = 0, generic = 0;
for (const o of other) {
  const res = await lookup(o.n, o.ci);
  await sleep(60);
  done++;
  if (res && res.type) {
    const cu = MAP[res.type];
    if (cu) { out.push({ id: o.id, cuisine: cu, _name: o.n, _gtype: res.type }); dist[cu] = (dist[cu] || 0) + 1; matched++; }
    else generic++;   // a real place but no cuisine-specific type (restaurant/food/fine_dining)
  }
  if (done % 25 === 0) process.stdout.write(`  ${done}/${other.length} (${matched} classified)\r`);
}
writeFileSync(join(HERE, "places_reclass.json"), JSON.stringify(out.map((x) => ({ id: x.id, cuisine: x.cuisine }))));
console.log(`\n=== ${matched}/${other.length} classified, ${generic} generic (stay Other), ${other.length - matched - generic} no Places match ===`);
console.log("by cuisine:", JSON.stringify(dist));
console.log("=== sample classifications ===");
out.slice(0, 30).forEach((x) => console.log("  " + x._name.padEnd(34) + " -> " + x.cuisine + "  (" + x._gtype + ")"));
