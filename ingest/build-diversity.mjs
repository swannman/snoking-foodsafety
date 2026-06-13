#!/usr/bin/env node
// Adds population + a race/ethnicity diversity index to each census tract in
// regions/tracts.geojson, from Census ACS5 table B03002 (King 033 + Snohomish 061,
// WA state 53). Diversity = Gini-Simpson index = 1 - Σ pᵢ²  over 8 mutually-exclusive
// groups (the probability two random residents differ in race/ethnicity), as a %.
// Run, then re-upload tracts.geojson to KV.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const YEAR = "2022";
// total, white-NH, black-NH, AIAN-NH, asian-NH, NHPI-NH, other-NH, two+-NH, hispanic
const VARS = ["B03002_001E", "B03002_003E", "B03002_004E", "B03002_005E", "B03002_006E", "B03002_007E", "B03002_008E", "B03002_009E", "B03002_012E"];

const KEY = process.env.CENSUS_KEY || "";
async function fetchCounty(county) {
  const url = `https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS.join(",")}&for=tract:*&in=state:53+county:${county}` + (KEY ? "&key=" + KEY : "");
  const rows = await (await fetch(url)).json();
  const head = rows[0], idx = (v) => head.indexOf(v);
  const out = new Map();
  for (const r of rows.slice(1)) {
    const total = +r[idx("B03002_001E")];
    const geoid = r[idx("state")] + r[idx("county")] + r[idx("tract")];
    if (!(total > 0)) { out.set(geoid, { pop: total || 0, div: null }); continue; }
    const groups = ["B03002_003E", "B03002_004E", "B03002_005E", "B03002_006E", "B03002_007E", "B03002_008E", "B03002_009E", "B03002_012E"];
    let sumsq = 0;
    for (const g of groups) { const p = (+r[idx(g)]) / total; sumsq += p * p; }
    out.set(geoid, { pop: total, div: Math.round((1 - sumsq) * 1000) / 10 });   // 0..100 (%)
  }
  return out;
}

const byGeoid = new Map();
for (const c of ["033", "061"]) for (const [k, v] of await fetchCounty(c)) byGeoid.set(k, v);
console.log("ACS tracts fetched:", byGeoid.size);

const path = join(HERE, "..", "regions", "tracts.geojson");
const g = JSON.parse(readFileSync(path, "utf8"));
let matched = 0;
for (const f of g.features) {
  const geoid = (f.properties.region_id || "").replace(/^t-/, "");
  const d = byGeoid.get(geoid);
  f.properties.demo = f.properties.demo || {};
  f.properties.demo.pop = f.properties.population ?? (d ? d.pop : null);
  if (d && d.div != null) { f.properties.demo.div = d.div; matched++; }
}
writeFileSync(path, JSON.stringify(g));
console.log(`merged diversity into ${matched}/${g.features.length} tracts; wrote ${path}`);
