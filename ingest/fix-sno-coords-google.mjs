// Re-geocode every Snohomish establishment via Google; where Google returns a precise ROOFTOP
// location that differs from our stored (Census-interpolated) point by more than THRESH metres,
// correct it. Census interpolates along a street segment and can land on the wrong street entirely
// (e.g. Butter Notes Cafe -> Trojan Way instead of Broadway). Updates D1 + merges the corrections
// into coord_overrides.json (committed) so they survive re-ingests regardless of the CI geocache.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = (k) => { try { return JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"))[k]; } catch { return null; } };
const GKEY = process.env.GOOGLE_KEY || cfg("GOOGLE_KEY");
const THRESH = 40; // metres — below this, Census/Google differences don't matter for the map
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d1 = (sql) => JSON.parse(execSync(`npx wrangler d1 execute snoking-foodsafety --remote --json --command ${JSON.stringify(sql)}`, { maxBuffer: 1 << 30 }))[0].results;
function dist(aLat, aLon, bLat, bLon) {
  const R = 6371000, dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
async function google(addr) {
  try {
    const r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?region=us&key=" + GKEY + "&address=" + encodeURIComponent(addr));
    const d = await r.json();
    if (d.status === "OK" && d.results[0]) { const g = d.results[0].geometry; return { lat: g.location.lat, lon: g.location.lng, type: g.location_type }; }
  } catch {}
  return null;
}
const rows = d1("SELECT id,name,address,city,zip,lat,lon FROM establishments WHERE county='snohomish' AND lat IS NOT NULL");
console.log(`${rows.length} Snohomish to check via Google (threshold ${THRESH}m)`);
const ov = existsSync(join(HERE, "coord_overrides.json")) ? JSON.parse(readFileSync(join(HERE, "coord_overrides.json"), "utf8")) : {};
const now = Date.now();
let sql = "", n = 0, roof = 0, corrected = 0, big = 0, done = 0;
for (const r of rows) {
  const addr = [r.address, r.city, "WA", r.zip].filter(Boolean).join(", ");
  const g = await google(addr);
  if (g && g.type === "ROOFTOP") {
    roof++;
    const dm = dist(r.lat, r.lon, g.lat, g.lon);
    if (dm > THRESH) {
      corrected++; if (dm > 100) big++;
      ov[r.id] = { lat: g.lat, lon: g.lon, note: `google rooftop; census was ${Math.round(dm)}m off` };
      sql += `UPDATE establishments SET lat=${g.lat}, lon=${g.lon}, updated_at=${now} WHERE id='${r.id.replace(/'/g, "''")}';\n`;
    }
  }
  await sleep(90);
  if (++done % 100 === 0) process.stdout.write(`  ${done}/${rows.length} (rooftop ${roof}, corrected ${corrected}, >100m ${big})\r`);
}
writeFileSync(join(HERE, "coord_overrides.json"), JSON.stringify(ov, null, 2));
writeFileSync(join(HERE, "_google_fix.sql"), sql);
console.log(`\nDone: ${roof} rooftop matches, ${corrected} corrected (>${THRESH}m), ${big} were >100m off.`);
console.log(`coord_overrides.json now has ${Object.keys(ov).length} entries; SQL -> _google_fix.sql`);
