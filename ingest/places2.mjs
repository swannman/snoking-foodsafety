#!/usr/bin/env node
// Second-pass Places lookup for the establishments STILL "other": use the full types[]
// array (not just primaryType) + editorialSummary, an expanded type map, and a keyword
// fallback over the summary. Writes ingest/places_reclass2.json.
//   node places2.mjs --limit=100   # test batch
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cuisineOf } from "./cuisine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIMIT = (() => { const a = args.find((x) => x.startsWith("--limit=")); return a ? parseInt(a.slice(8), 10) : 0; })();
function cfg(k, d) { if (process.env[k]) return process.env[k];
  try { const c = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")); if (c[k]) return c[k]; } catch {} return d; }
const KEY = cfg("GOOGLE_KEY", ""), WORKER_URL = cfg("WORKER_URL", "https://snoking-foodsafety.3lemenopy.workers.dev").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAP = {
  pizza_restaurant: "pizza", mexican_restaurant: "mexican", taco_restaurant: "mexican",
  chinese_restaurant: "chinese", japanese_restaurant: "japanese", sushi_restaurant: "japanese", ramen_restaurant: "japanese",
  thai_restaurant: "thai", vietnamese_restaurant: "vietnamese", korean_restaurant: "korean", indian_restaurant: "indian",
  mediterranean_restaurant: "mediterranean", greek_restaurant: "mediterranean", lebanese_restaurant: "mediterranean",
  middle_eastern_restaurant: "mediterranean", turkish_restaurant: "mediterranean", afghani_restaurant: "mediterranean", spanish_restaurant: "mediterranean",
  ethiopian_restaurant: "african", african_restaurant: "african",
  italian_restaurant: "italian", barbecue_restaurant: "bbq", steak_house: "bbq",
  hamburger_restaurant: "burgers", fast_food_restaurant: "fastfood", snack_bar: "fastfood",
  sandwich_shop: "sandwich", deli: "sandwich", bagel_shop: "sandwich",
  seafood_restaurant: "seafood",
  cafe: "coffee", coffee_shop: "coffee", tea_house: "coffee", juice_shop: "coffee",
  bakery: "bakery", dessert_shop: "bakery", dessert_restaurant: "bakery", ice_cream_shop: "bakery", donut_shop: "bakery", chocolate_shop: "bakery", candy_store: "bakery",
  bar: "bar", pub: "bar", wine_bar: "bar", bar_and_grill: "bar", cocktail_bar: "bar", sports_bar: "bar", brewpub: "bar", night_club: "bar", live_music_venue: "bar",
  grocery_store: "grocery", supermarket: "grocery", convenience_store: "grocery", asian_grocery_store: "grocery", butcher_shop: "grocery", market: "grocery", food_store: "grocery", liquor_store: "grocery", gas_station: "grocery", warehouse_store: "grocery",
  asian_restaurant: "asian", indonesian_restaurant: "asian",
  american_restaurant: "american", breakfast_restaurant: "cafe_diner", brunch_restaurant: "cafe_diner", diner: "cafe_diner",
  // institutional (industry group)
  hotel: "hotel", lodging: "hotel", motel: "hotel", resort_hotel: "hotel", bed_and_breakfast: "hotel", extended_stay_hotel: "hotel",
  hospital: "seniorcare", school: "school", primary_school: "school", secondary_school: "school", university: "school", preschool: "school",
  church: "venue", place_of_worship: "venue", hindu_temple: "venue", mosque: "venue", synagogue: "venue",
  stadium: "venue", arena: "venue", performing_arts_theater: "venue", movie_theater: "venue", bowling_alley: "venue", casino: "venue", golf_course: "venue", country_club: "venue", amusement_center: "venue", amusement_park: "venue", banquet_hall: "venue", convention_center: "venue", community_center: "venue", tourist_attraction: "venue", museum: "venue",
};
const FOODY = /restaurant|cafe|coffee|bakery|bar|grill|store|food|cuisine|deli|grocer|pub|shop|diner|snack|hotel|school|hospital|church|stadium|theater|casino|bowling|golf/;

async function lookup(name, city) {
  const q = name + (city ? ", " + city : "") + ", WA";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "places.displayName,places.primaryType,places.types,places.editorialSummary" },
        body: JSON.stringify({ textQuery: q, maxResultCount: 1, regionCode: "US" }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.error) return null;
      return (j.places || [])[0] || null;
    } catch (e) { if (i === 2) return null; await sleep(500 * (i + 1)); }
  }
}
function classify(p) {
  if (!p) return [null, "nomatch"];
  const cand = [p.primaryType].concat(p.types || []).filter((t) => t && FOODY.test(t));
  for (const t of cand) if (MAP[t]) return [MAP[t], "type:" + t];
  // fallback: keyword-classify the editorial summary
  if (p.editorialSummary?.text) { const cu = cuisineOf(p.editorialSummary.text); if (cu !== "other") return [cu, "summary"]; }
  return [null, "generic"];
}

const j = await (await fetch(WORKER_URL + "/api/establishments")).json();
let other = j.items.filter((x) => x.cu === "other");
if (LIMIT) other = other.slice().sort(() => 0.5 - Math.random()).slice(0, LIMIT);
console.log(`2nd-pass lookup of ${other.length} still-"other"…`);
const out = [], dist = {}, via = {}; let done = 0;
for (const o of other) {
  const p = await lookup(o.n, o.ci); await sleep(60);
  const [cu, how] = classify(p);
  if (cu) { out.push({ id: o.id, cuisine: cu, _name: o.n, _how: how }); dist[cu] = (dist[cu] || 0) + 1; via[how.split(":")[0]] = (via[how.split(":")[0]] || 0) + 1; }
  if (++done % 25 === 0) process.stdout.write(`  ${done}/${other.length} (${out.length} new)\r`);
}
writeFileSync(join(HERE, "places_reclass2.json"), JSON.stringify(out.map((x) => ({ id: x.id, cuisine: x.cuisine }))));
console.log(`\n=== recovered ${out.length}/${other.length} more (${(100 * out.length / other.length).toFixed(0)}%) ===`);
console.log("by cuisine:", JSON.stringify(dist));
console.log("by method:", JSON.stringify(via));
console.log("=== samples ==="); out.slice(0, 30).forEach((x) => console.log("  " + x._name.slice(0, 32).padEnd(33) + " -> " + x.cuisine + "  (" + x._how + ")"));
