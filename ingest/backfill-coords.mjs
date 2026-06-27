// One-off: geocode the Snohomish establishments that currently have no coordinates and
// emit an SQL file of UPDATEs. Mirrors ingest.mjs's geocoding (cleaned-address Census
// oneline -> Google fallback on the RAW address) and merges hits into geocache.json so
// future ingests keep them. Run: node backfill-coords.mjs ; then apply _backfill.sql via wrangler.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = (k, d = "") => { try { return JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"))[k] ?? d; } catch { return d; } };
const GOOGLE_KEY = process.env.GOOGLE_KEY || cfg("GOOGLE_KEY", "");
const CACHE_PATH = join(HERE, "geocache.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanStreet(a) {
  let s = (a || "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+(STE|SUITE|UNIT|APT|BLDG|RM|#).*$/i, "");
  s = s.replace(/\s+[#].*$/, "");
  if (!/\b(HIGHWAY|HWY|SR|STATE ROUTE|ROUTE|RTE|US|HW)\s+\d+$/i.test(s))
    s = s.replace(/\s+\d+\s*$/, "").replace(/\s+[A-Z]\s*$/, "");
  return s.trim();
}
async function getJson(u) { const r = await fetch(u); return r.json(); }
async function onelineGeocode(street, city, zip) {
  const addr = [street, city, "WA", zip].filter(Boolean).join(", ");
  try { const d = await getJson("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(addr));
    const m = d?.result?.addressMatches?.[0]; if (m) return { lat: m.coordinates.y, lon: m.coordinates.x }; } catch {}
  return null;
}
async function googleGeocode(addr) {
  if (!GOOGLE_KEY) return null;
  try { const d = await getJson("https://maps.googleapis.com/maps/api/geocode/json?key=" + GOOGLE_KEY + "&address=" + encodeURIComponent(addr) + "&region=us&components=administrative_area:WA");
    if (d.status === "OK" && d.results[0]) { const l = d.results[0].geometry.location; return { lat: l.lat, lon: l.lng }; } } catch {}
  return null;
}

const rows = JSON.parse(readFileSync(join(HERE, "_nullcoords.json"), "utf8"));
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
const now = Date.now();
let sql = "", census = 0, google = 0, miss = 0, d = 0;
for (const r of rows) {
  const street = cleanStreet(r.address), key = `${street}|${r.city}|${r.zip}`;
  let h = await onelineGeocode(street, r.city, r.zip), via = "census";
  if (!h) { h = await googleGeocode([r.address, r.city, "WA", r.zip].filter(Boolean).join(", ")); via = "google"; }
  if (h) {
    cache[key] = h; via === "google" ? google++ : census++;
    sql += `UPDATE establishments SET lat=${h.lat}, lon=${h.lon}, updated_at=${now} WHERE id='${r.id.replace(/'/g, "''")}';\n`;
  } else miss++;
  await sleep(120);
  if (++d % 20 === 0) process.stdout.write(`  ${d}/${rows.length}  (census ${census}, google ${google}, miss ${miss})\r`);
}
writeFileSync(join(HERE, "_backfill.sql"), sql);
writeFileSync(CACHE_PATH, JSON.stringify(cache));
console.log(`\nDone: ${census + google}/${rows.length} geocoded (census ${census}, google ${google}, still-missing ${miss}). SQL -> _backfill.sql, cache updated.`);
