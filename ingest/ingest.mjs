#!/usr/bin/env node
// SnoKing Food Safety ingester.
// Pulls the latest food-establishment rating for every place in King + Snohomish
// counties — including violation detail, the earliest inspection on record ("in
// operation since"), and an inferred cuisine — geocodes Snohomish, normalizes both
// to a 1..4 rating, and POSTs them to the Worker /ingest endpoint.
//
//   node ingest.mjs                 # full run -> POST to the Worker
//   node ingest.mjs --dry           # write ./data.json, don't POST (no token needed)
//   node ingest.mjs --king-only     # one county only (also --sno-only)
//   node ingest.mjs --no-geocode    # skip Snohomish geocoding (debug)
//   node ingest.mjs --limit=200     # Snohomish: only crawl the first N facilities (debug)
//
// Config (env or ./config.json): WORKER_URL, INGEST_TOKEN.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cuisineOf } from "./cuisine.mjs";
import { blooperTag, blooperText, redactName } from "./bloopers.mjs";
import { loadTagger } from "./regions.mjs";
let tagTract = () => null;
try { tagTract = loadTagger(); } catch (e) { console.log("tract tagger disabled:", e.message); }

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY = has("--dry"), KING_ONLY = has("--king-only"), SNO_ONLY = has("--sno-only"), NO_GEOCODE = has("--no-geocode");
const LIMIT = (() => { const a = args.find((x) => x.startsWith("--limit=")); return a ? parseInt(a.slice(8), 10) : 0; })();

function cfg(k, d) {
  if (process.env[k]) return process.env[k];
  try { const c = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")); if (c[k]) return c[k]; } catch {}
  return d;
}
const WORKER_URL = cfg("WORKER_URL", "https://snoking-foodsafety.3lemenopy.workers.dev").replace(/\/$/, "");
const INGEST_TOKEN = cfg("INGEST_TOKEN", "");
const GOOGLE_KEY = cfg("GOOGLE_KEY", "");   // for geocoding fallback when Census can't match (e.g. "International Blvd"/SR-99)
const CACHE_PATH = join(HERE, "geocache.json");
const PROG_PATH = join(HERE, "programs.json");   // FacilityId -> {programId, category} cache

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { fatal: true });
      return await r.json();
    } catch (e) { if (e.fatal || i === tries - 1) throw e; await sleep(500 * (i + 1)); }
  }
}
const RATING_LABEL = { 1: "Excellent", 2: "Good", 3: "Okay", 4: "Needs to Improve" };
const dstr = (s) => (s ? String(s).slice(0, 10) : null);
const pointRating = (p) => (p == null || isNaN(p) ? null : p <= 0 ? 1 : p <= 15 ? 2 : p <= 35 ? 3 : 4);
// classify the inspection type that set the current rating, so the "recently changed" view can
// say whether a change came from a fresh routine (the meaningful kind) vs a reinspection.
const classifySvc = (s) => { if (!s) return null; s = String(s); return /RE-?INSPECT|REINSPECT|FOLLOW.?UP|RECHECK|RETURN/i.test(s) ? "reinspection" : /ROUTINE/i.test(s) ? "routine" : "other"; };
function avgRating(history, n = 5) {   // mean rating over the most recent N inspections (newest-first)
  const rs = (history || []).map((h) => pointRating(h.score)).filter((r) => r != null).slice(0, n);
  return rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
}
const isRoutine = (svc) => /routine/i.test(svc || "");
function ratingRoutine(history) {   // rating of the most recent ROUTINE inspection (ignores reinspections)
  for (const h of history || []) if (isRoutine(h.svc)) { const r = pointRating(h.score); if (r != null) return r; }
  return null;
}
function ratingWorst(history) {     // worst (highest) rating across all stored inspections
  let w = null;
  for (const h of history || []) { const r = pointRating(h.score); if (r != null && (w == null || r > w)) w = r; }
  return w;
}
function poorFrac(history) {         // share of ROUTINE inspections rated Okay-or-worse (>=3); 0..1
  const s = (history || []).filter((h) => isRoutine(h.svc) && pointRating(h.score) != null);
  return s.length ? Math.round((s.filter((h) => pointRating(h.score) >= 3).length / s.length) * 1000) / 1000 : null;
}
function worstPoints(history) {      // highest single-inspection score on record (raw points)
  let w = null;
  for (const h of history || []) if (h.score != null && (w == null || h.score > w)) w = h.score;
  return w;
}

// ─────────────────────── King County (ArcGIS / EPL) ──────────────────────────
// King retired its Socrata feed (frozen at 2025-11) and now publishes the data as
// three ArcGIS feature layers under its org Ej0PsM5Aw677QF1W:
//   EPL_BusinessPoint/0  — one point per active business: current grade + coords + address
//   EPL_BusinessPoint/1  — EPL_Inspection: inspection history (date/score/type/result), joins on Business_Record_ID
//   EPL_BusinessPoint/2  — EPL_Violation:  violations (descr/points/type),               joins on Inspection_Serial_Num
// EPL history only goes back to ~2022, so we preserve the deeper "in operation since"
// date and all prior cuisine classification (keyword + agent + Google Places) by
// harvesting the current live API by name+address before re-keying to Business_Record_ID.
const EPL = "https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/EPL_BusinessPoint/FeatureServer";
const KC_GRADE = { "Excellent": 1, "Good": 2, "Okay": 3, "Needs to Improve": 4 };
const knorm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const kHouseNo = (a) => { const m = String(a || "").match(/^\s*(\d+)/); return m ? m[1] : ""; };

// page through an ArcGIS FeatureServer layer/table, returning all attribute rows. When
// geom=true, coords live only in the geometry (the *_Lat/_Long fields are null), so we
// request WGS84 geometry and stash lon/lat as _lon/_lat on each attribute row.
async function arcAll(layer, outFields, where = "1=1", label = "", geom = false) {
  const out = [], limit = 2000;
  for (let off = 0; ; off += limit) {
    const u = EPL + "/" + layer + "/query?where=" + encodeURIComponent(where) +
      "&outFields=" + encodeURIComponent(outFields) + "&returnGeometry=" + (geom ? "true&outSR=4326" : "false") +
      "&orderByFields=OBJECTID&resultOffset=" + off + "&resultRecordCount=" + limit + "&f=json";
    const j = await getJson(u);
    if (j.error) throw new Error("ArcGIS " + label + ": " + JSON.stringify(j.error).slice(0, 200));
    const feats = j.features || [];
    for (const f of feats) { if (geom && f.geometry) { f.attributes._lon = f.geometry.x; f.attributes._lat = f.geometry.y; } out.push(f.attributes); }
    process.stdout.write(`  king ${label}: ${out.length}\r`);
    if (feats.length < limit && !j.exceededTransferLimit) break;
    if (feats.length === 0) break;
  }
  return out;
}

// harvest resolved cuisine + deep first-seen date from the CURRENT live API (still
// Socrata-derived on first run), keyed by name+address with a street-number fallback.
async function harvestKing() {
  try {
    const j = await getJson(WORKER_URL + "/api/establishments?nocache=" + Date.now());   // bypass edge cache — must read CURRENT cuisines/ages
    const exact = new Map(), byNum = new Map(), dup = new Set();
    for (const it of j.items || []) {
      if (it.co !== "k") continue;
      const rec = { cu: it.cu, fd: it.fd || null };
      const e = knorm(it.n) + "|" + knorm(it.a);
      const ex = exact.get(e);
      if (ex) { if (rec.fd && (!ex.fd || rec.fd < ex.fd)) ex.fd = rec.fd; } else exact.set(e, rec);
      const nk = knorm(it.n) + "#" + kHouseNo(it.a);
      if (byNum.has(nk)) dup.add(nk); else byNum.set(nk, rec);
    }
    for (const k of dup) byNum.delete(k);   // drop ambiguous name+number keys
    return { exact, byNum };
  } catch (e) { console.log("  king harvest skipped:", e.message); return { exact: new Map(), byNum: new Map() }; }
}

async function king() {
  const { exact, byNum } = await harvestKing();
  console.log(`  king: harvested ${exact.size} prior cuisine/age records from live API`);
  // Permit status is administratively noisy — an open restaurant can read "Expired" while its
  // renewal lags (e.g. Modoo Hansang, graded Excellent, inspected recently). So fetch Active plus
  // the lapsed-but-maybe-open statuses, then below keep the non-Active ones ONLY if inspected
  // recently (a current grade is the real "still operating" signal). Excludes Suspended / pending
  // application states.
  const biz = await arcAll(0, "Business_Record_ID,Business_Name,Business_Address,Business_City,Business_Location_Zip,Business_Grade,Business_Establishment_Descr,Business_Status", "Business_Status IN ('Active','Expired','Off Season','Fees Due','Change of Permit in Progr')", "businesses", true);
  console.log(`\n  king: ${biz.length} businesses (active + lapsed-permit candidates)`);
  const RECENT_CUT = new Date(Date.now() - 548 * 86400000).toISOString().slice(0, 10);   // ~18 months ago
  const HIST_CUT = new Date(Date.now() - 1096 * 86400000).toISOString().slice(0, 10);    // ~3 years ago (history-with-violations window)
  const insps = await arcAll(1, "Inspection_Serial_Num,Business_Record_ID,Inspection_Type,Inspection_Date,Inspection_Score,Inspection_Result", "1=1", "inspections");
  console.log(`\n  king: ${insps.length} inspections`);
  const viols = await arcAll(2, "Inspection_Serial_Num,Violation_Type,Violation_Descr,Violation_Points", "1=1", "violations");
  console.log(`\n  king: ${viols.length} violations`);

  const inspBy = new Map(), violBy = new Map();
  for (const r of insps) { const k = r.Business_Record_ID; (inspBy.get(k) || inspBy.set(k, []).get(k)).push(r); }
  for (const v of viols) { const k = v.Inspection_Serial_Num; (violBy.get(k) || violBy.set(k, []).get(k)).push(v); }

  const out = [];
  for (const b of biz) {
    const lat = b._lat, lon = b._lon;
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const recId = b.Business_Record_ID;
    const ins = (inspBy.get(recId) || []).slice().sort((x, y) => String(x.Inspection_Date || "").localeCompare(String(y.Inspection_Date || "")));   // ascending
    const mh = ins.slice(-8).reverse().map((x) => ({
      date: dstr(x.Inspection_Date), score: x.Inspection_Score != null ? +x.Inspection_Score : null,
      label: x.Inspection_Result || null, svc: x.Inspection_Type || null }));   // last 8 — drives the rating metrics (unchanged)
    const kviol = (serial) => (violBy.get(serial) || []).map((v) => ({ label: v.Violation_Descr, points: v.Violation_Points != null ? +v.Violation_Points : null, type: v.Violation_Type || null }));
    // display history: every inspection in the last 3 years (newest first) WITH its violations — the "reasons" for each score
    const history = ins.filter((x) => { const d = dstr(x.Inspection_Date); return d && d >= HIST_CUT; }).reverse().slice(0, 24).map((x) => ({
      date: dstr(x.Inspection_Date), score: x.Inspection_Score != null ? +x.Inspection_Score : null,
      label: x.Inspection_Result || null, svc: x.Inspection_Type || null, v: kviol(x.Inspection_Serial_Num) }));
    const latest = ins.length ? ins[ins.length - 1] : null;
    // non-Active permit: only keep if inspected within ~18 months (clearly still operating)
    if ((b.Business_Status || "").trim() !== "Active") {
      const ld = latest ? dstr(latest.Inspection_Date) : null;
      if (!ld || ld < RECENT_CUT) continue;
    }
    const latestScore = latest && latest.Inspection_Score != null ? +latest.Inspection_Score : null;
    // King grades only restaurant-type establishments; schools/institutions are ungraded ->
    // derive a rating from points (like Snohomish) so nothing shows "Unrated".
    const grade = KC_GRADE[String(b.Business_Grade || "").trim()] || null;
    const ravg = avgRating(mh);
    const rating = grade != null ? grade : (pointRating(latestScore) ?? (ravg != null ? Math.round(ravg) : null));
    if (rating == null) continue;   // registered but never inspected & ungraded — no rating data, skip (old feed never listed these)
    const latestViol = latest ? kviol(latest.Inspection_Serial_Num) : [];
    // preserve prior cuisine + deeper age: match harvested live data by name+address, else street number
    const h = exact.get(knorm(b.Business_Name) + "|" + knorm(b.Business_Address)) ||
              byNum.get(knorm(b.Business_Name) + "#" + kHouseNo(b.Business_Address));
    const eplFirst = ins.length ? dstr(ins[0].Inspection_Date) : null;
    let first_date = eplFirst;
    if (h && h.fd && (!first_date || h.fd < first_date)) first_date = h.fd;
    const cuisine = (h && h.cu) ? h.cu : cuisineOf(b.Business_Name);
    out.push({
      id: "king:" + recId, county: "king", name: (b.Business_Name || "").trim(), address: (b.Business_Address || "").trim(),
      city: (b.Business_City || "").trim(), zip: String(b.Business_Location_Zip || "").trim(), lat, lon,
      cuisine,
      rating, grade,
      score: latestScore, result: latest ? (latest.Inspection_Result || null) : null,
      // graded King ratings are a rolling average, not one inspection -> "grade"; ungraded ones track the latest inspection
      rating_svc: grade != null ? "grade" : classifySvc(latest ? latest.Inspection_Type : null),
      inspect_date: latest ? dstr(latest.Inspection_Date) : null, first_date,
      report_url: "https://kingcounty.gov/en/dept/dph/health-safety/food-safety/search-restaurant-safety-ratings",
      rating_avg: ravg, rating_avg_all: avgRating(mh, 99),
      rating_routine: ratingRoutine(mh) ?? rating, rating_worst: ratingWorst(mh) ?? rating, poor_frac: poorFrac(mh), worst_points: worstPoints(mh),
      tract_id: tagTract(lon, lat),
      detail: { violations: latestViol, history },
    });
  }
  console.log(`\n  king: ${out.length} program records`);
  await fixGeocodes(out);
  const merged = mergePrograms(out);
  console.log(`  king: ${merged.length} establishments after merging duplicate program permits`);
  return merged;
}

// Some EPL points are mis-geocoded: a record lands on ANOTHER business's point in a
// different city (e.g. PUPUSERIA CABANAS — a SeaTac address — placed on the Microsoft-
// Redmond commissary point, where it stacks under unrelated Redmond vendors). Detect
// these by city disagreement at a shared exact point, then re-geocode from the clean
// street address via Census and move the ones that match. Runs BEFORE the merge so the
// corrected coords cluster where they belong.
async function fixGeocodes(list) {
  const nc = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "");
  const byCoord = new Map();
  for (const r of list) { const k = r.lat.toFixed(6) + "," + r.lon.toFixed(6); (byCoord.get(k) || byCoord.set(k, []).get(k)).push(r); }
  const suspects = [];
  for (const v of byCoord.values()) {
    if (v.length < 2) continue;
    const cities = {}; for (const r of v) { const c = nc(r.city); if (c) cities[c] = (cities[c] || 0) + 1; }
    const keys = Object.keys(cities); if (keys.length < 2) continue;
    const plural = keys.sort((a, b) => cities[b] - cities[a])[0];
    for (const r of v) if (nc(r.city) && nc(r.city) !== plural) suspects.push(r);
  }
  if (!suspects.length) { console.log("  king: no geocode-mismatch suspects"); return; }
  console.log(`  king: re-geocoding ${suspects.length} city-mismatch records via Census`);
  const found = await censusBatch(suspects.map((r) => ({ id: r.id, street: cleanStreet(r.address), city: r.city, zip: String(r.zip || "").slice(0, 5) })));
  let moved = 0, gfb = 0;
  for (const r of suspects) {
    let h = found.get(r.id);
    if (!h) { h = await googleGeocode([cleanStreet(r.address), r.city, "WA", String(r.zip || "").slice(0, 5)].filter(Boolean).join(", ")); if (h) gfb++; await sleep(60); }
    if (h && isFinite(h.lat) && isFinite(h.lon)) { r.lat = h.lat; r.lon = h.lon; r.tract_id = tagTract(h.lon, h.lat); moved++; }
  }
  console.log(`\n  king: moved ${moved}/${suspects.length} to address-accurate coords (${gfb} via Google fallback)`);
}
async function googleGeocode(addr) {
  if (!GOOGLE_KEY) return null;
  try { const d = await getJson("https://maps.googleapis.com/maps/api/geocode/json?key=" + GOOGLE_KEY + "&address=" + encodeURIComponent(addr) + "&region=us&components=administrative_area:WA");
    if (d.status === "OK" && d.results[0]) { const l = d.results[0].geometry.location; return { lat: l.lat, lon: l.lng }; } } catch {}
  return null;
}

// King issues a SEPARATE permit (Business_Record_ID) per program at a location — a
// grocery's deli/bakery/meat counter, a stadium's many concessions — each with its own
// grade and a shared geocode. Without merging, one Safeway shows up 5-7x (T-Mobile Park
// ~76x) with conflicting ratings. Collapse same-name + same-point records into one pin:
// stable id (smallest in the group), headline rating from the most-recently-inspected
// program, but age + all worst/avg metrics computed over the COMBINED history so a bad
// sub-program still flags the location.
function mergePrograms(list) {
  const groups = new Map();
  for (const r of list) {
    const k = knorm(r.name) + "|" + r.lat.toFixed(4) + "," + r.lon.toFixed(4);
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    g.sort((a, b) => String(b.inspect_date || "").localeCompare(String(a.inspect_date || "")));   // most recent first
    const rep = { ...g[0] };
    rep.id = g.map((r) => r.id).sort()[0];                          // stable across runs (independent of recency)
    let hist = [];
    for (const r of g) hist = hist.concat((r.detail && r.detail.history) || []);
    hist.sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 10);
    hist = hist.slice(0, 10);
    rep.first_date = g.reduce((m, r) => (r.first_date && (!m || r.first_date < m) ? r.first_date : m), rep.first_date);
    rep.rating_avg = avgRating(hist); rep.rating_avg_all = avgRating(hist, 99);
    rep.rating_routine = ratingRoutine(hist) ?? rep.rating; rep.rating_worst = ratingWorst(hist) ?? rep.rating;
    rep.poor_frac = poorFrac(hist); rep.worst_points = worstPoints(hist);
    rep.detail = { violations: (g[0].detail && g[0].detail.violations) || [], history: hist };
    out.push(rep);
  }
  return out;
}

// ───────────────────────── Snohomish County (EnvisionConnect) ─────────────────
const SNO_OID = "0c75a5fa-3183-4b7c-b28e-a72200ed49a9";
const SNO_API = "https://snohomishonline.envisionconnect.com/api/pressAgentClient";
const ALPHA = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", " ", "'", "&", "#", "-", ".", "/", "(", ")", ",", "+"];

async function snoSearch(prefix) {
  return getJson(SNO_API + "/searchFacilities?PressAgentOid=" + SNO_OID, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "snoking-foodsafety/1.0" },
    body: JSON.stringify({ FacilityName: prefix }),
  });
}
async function snohomishList() {                     // beat the 50-result cap via prefix expansion
  const byId = new Map(); let reqs = 0;
  async function recur(prefix) {
    const res = await snoSearch(prefix); reqs++;
    if (reqs % 25 === 0) process.stdout.write(`  sno: ${reqs} queries, ${byId.size} facilities\r`);
    await sleep(60);
    for (const f of res) byId.set(f.FacilityId, f);
    if (res.length >= 50) for (const c of ALPHA) await recur(prefix + c);
  }
  for (const c of ALPHA) await recur(c);
  console.log(`\n  sno: enumerated ${byId.size} facilities in ${reqs} queries`);
  return [...byId.values()];
}
function snoRating(points) {            // violation points -> unified 1..4 (lower=better)
  if (points == null || isNaN(points)) return null;
  if (points <= 0) return 1; if (points <= 15) return 2; if (points <= 35) return 3; return 4;
}
async function snoProgram(facilityId, progCache) {   // FacilityId -> {programId, category}
  if (progCache[facilityId]) return progCache[facilityId];
  const progs = await getJson(SNO_API + "/programs?FacilityId=" + facilityId + "&PressAgentOid=" + SNO_OID);
  const food = (progs || []).find((p) => p.ProgramCategory === "FOOD") || progs?.[0];
  const v = food ? { programId: food.ProgramId, category: food.PE_DESCRIPTION || null } : null;
  progCache[facilityId] = v; return v;
}
async function snoInspections(programId) {
  return getJson(SNO_API + "/inspections?ProgramId=" + programId + "&PressAgentOid=" + SNO_OID);
}

async function snohomish() {
  let list = await snohomishList();
  if (LIMIT) list = list.slice(0, LIMIT);
  const progCache = existsSync(PROG_PATH) ? JSON.parse(readFileSync(PROG_PATH, "utf8")) : {};
  const recs = [], bloopers = [];
  const HIST_CUT = new Date(Date.now() - 1096 * 86400000).toISOString().slice(0, 10);   // ~3 years ago
  const svViol = (ins) => ((ins && ins.violations) || []).map((v) => ({
    label: v.violation_description || v.violation_text || ("Violation " + (v.violation_code || "")),
    points: null, type: null,
    note: (v.v_memo || "").replace(/\r\n?/g, "\n").trim().slice(0, 700) || null }));
  let done = 0, fails = 0;
  for (const f of list) {
    const { city, zip } = parseCityStateZip(f.CityStateZip);
    let firstDate = null, latest = null, history = [], mh = [], category = null, score = f.LastScore != null ? +f.LastScore : null;
    try {
      const prog = await snoProgram(f.FacilityId, progCache); await sleep(55);
      if (prog) {
        category = prog.category;
        const insp = (await snoInspections(prog.programId)) || []; await sleep(55);
        insp.sort((a, b) => (a.activity_date < b.activity_date ? 1 : -1));   // newest first
        if (insp.length) firstDate = dstr(insp[insp.length - 1].activity_date);
        latest = insp.find((x) => /ROUTINE/i.test(x.service)) || insp[0];
        if (latest) score = latest.score != null ? +latest.score : score;
        mh = insp.slice(0, 8).map((x) => ({ date: dstr(x.activity_date), score: x.score != null ? +x.score : null, label: x.service || null, svc: x.service || null }));   // last 8 — drives the rating metrics (unchanged)
        // display history: every inspection in the last 3 years (newest first) WITH its violations — the "reasons" for each score
        history = insp.filter((x) => { const d = dstr(x.activity_date); return d && d >= HIST_CUT; }).slice(0, 24).map((x) => ({ date: dstr(x.activity_date), score: x.score != null ? +x.score : null, label: x.service || null, svc: x.service || null, v: svViol(x) }));
        // scan EVERY inspection's violation narratives for bloopers (the funny reel)
        const rurl = SNO_API.replace("/api/pressAgentClient", "") + "/#/pa1/detail/" + f.FacilityId + (prog.programId ? "/" + prog.programId : "");
        for (const ins of insp) for (const v of (ins.violations || [])) {
          const tag = blooperTag(v.v_memo); if (!tag) continue;
          const text = blooperText(v.v_memo); if (text.length < 14) continue;
          bloopers.push({ id: f.FacilityId + ":" + (v.Oid || (dstr(ins.activity_date) + ":" + (v.violation_code || ""))),
            facilityId: f.FacilityId, name: (f.FacilityName || "").trim(), city, date: dstr(ins.activity_date), tag,
            label: v.violation_description || v.violation_text || "", text: redactName(text.slice(0, 400), f.FacilityName), report_url: rurl });
        }
      }
    } catch (e) { fails++; }
    if (++done % 50 === 0) process.stdout.write(`  sno crawl: ${done}/${list.length} (${fails} errors, ${bloopers.length} bloopers)\r`);
    const violations = svViol(latest);
    const ravg = avgRating(mh);
    const rating = snoRating(score) ?? (ravg != null ? Math.round(ravg) : null);
    recs.push({
      id: "sno:" + f.FacilityId, county: "snohomish", name: (f.FacilityName || "").trim(),
      address: (f.Address || "").replace(/\s+/g, " ").trim(), city, zip, lat: null, lon: null,
      cuisine: cuisineOf(f.FacilityName), rating, grade: null, score,
      // Snohomish rating tracks the latest ROUTINE (reinspections never move it), so this is ~always "routine"
      rating_svc: classifySvc(latest ? latest.service : null),
      result: null, inspect_date: latest ? dstr(latest.activity_date) : null, first_date: firstDate,
      report_url: SNO_API.replace("/api/pressAgentClient", "") + "/#/pa1/detail/" + f.FacilityId +
        (progCache[f.FacilityId]?.programId ? "/" + progCache[f.FacilityId].programId : ""),
      rating_avg: ravg, rating_avg_all: avgRating(mh, 99),
      rating_routine: ratingRoutine(mh) ?? rating, rating_worst: ratingWorst(mh) ?? rating, poor_frac: poorFrac(mh), worst_points: worstPoints(mh),
      detail: { violations, history, category },
    });
  }
  writeFileSync(PROG_PATH, JSON.stringify(progCache));
  console.log(`\n  sno crawl: ${done} facilities, ${fails} errors, ${bloopers.length} bloopers`);
  if (!NO_GEOCODE) await geocodeSno(recs);
  // attach coords to bloopers from their establishment
  const coord = {}; recs.forEach((r) => { coord[r.id.replace("sno:", "")] = { lat: r.lat, lon: r.lon }; });
  bloopers.forEach((b) => { const c = coord[b.facilityId]; if (c) { b.lat = c.lat; b.lon = c.lon; } });
  recs._bloopers = bloopers;
  return recs;
}

function parseCityStateZip(s) {
  const m = (s || "").match(/^(.*?)\s+([A-Z]{2})\s+(\d{5})/);
  return m ? { city: m[1].trim(), zip: m[3] } : { city: (s || "").replace(/\s+WA.*/, "").trim(), zip: "" };
}
function cleanStreet(a) {
  let s = (a || "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+(STE|SUITE|UNIT|APT|BLDG|RM|#).*$/i, "");
  s = s.replace(/\s+[#].*$/, "").replace(/\s+\d+\s*$/, "").replace(/\s+[A-Z]\s*$/, "").trim();
  return s;
}
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}
async function censusBatch(records) {
  const found = new Map();
  for (let i = 0; i < records.length; i += 5000) {
    const chunk = records.slice(i, i + 5000);
    const csv = chunk.map((r) => `${r.id},"${r.street}","${r.city}",WA,${r.zip}`).join("\n");
    const form = new FormData();
    form.append("benchmark", "Public_AR_Current");
    form.append("addressFile", new Blob([csv], { type: "text/csv" }), "addr.csv");
    let text = "";
    try { const r = await fetch("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", { method: "POST", body: form }); text = await r.text(); }
    catch (e) { console.log("  census batch error:", e.message); continue; }
    for (const line of text.split("\n")) { if (!line.trim()) continue; const f = parseCsvLine(line);
      if (f[2] === "Match" && f[5]) { const [lon, lat] = f[5].split(","); found.set(f[0], { lat: +lat, lon: +lon }); } }
    process.stdout.write(`  sno geocode: ${found.size}/${records.length} matched\r`);
  }
  return found;
}
async function onelineGeocode(street, city, zip) {
  const addr = [street, city, "WA", zip].filter(Boolean).join(", ");
  try { const d = await getJson("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(addr));
    const m = d?.result?.addressMatches?.[0]; if (m) return { lat: m.coordinates.y, lon: m.coordinates.x }; } catch {}
  return null;
}
async function geocodeSno(recs) {
  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
  const keyOf = (r) => `${cleanStreet(r.address)}|${r.city}|${r.zip}`;
  const need = [];
  for (const r of recs) { const c = cache[keyOf(r)]; if (c) { r.lat = c.lat; r.lon = c.lon; }
    else need.push({ id: r.id, key: keyOf(r), street: cleanStreet(r.address), city: r.city, zip: r.zip, rec: r }); }
  console.log(`  sno geocode: ${need.length} to look up (${recs.length - need.length} cached)`);
  if (need.length) {
    const found = await censusBatch(need);
    for (const n of need) { const h = found.get(n.id); if (h) { n.rec.lat = h.lat; n.rec.lon = h.lon; cache[n.key] = h; } }
    const misses = need.filter((n) => !found.has(n.id));
    console.log(`\n  sno geocode: ${misses.length} batch misses -> oneline fallback`);
    let d = 0, fb = 0;
    for (const n of misses) { const h = await onelineGeocode(n.street, n.city, n.zip);
      if (h) { n.rec.lat = h.lat; n.rec.lon = h.lon; cache[n.key] = h; fb++; } await sleep(120);
      if (++d % 25 === 0) process.stdout.write(`  oneline: ${d}/${misses.length} (${fb} found)\r`); }
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
  console.log(`\n  sno: ${recs.filter((r) => r.lat != null).length}/${recs.length} geocoded`);
}

// ──────────────────────────────── push ───────────────────────────────────────
async function push(records) {
  let n = 0;
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200).map((r) => ({ ...r, detail: JSON.stringify(r.detail || {}) }));
    const r = await fetch(WORKER_URL + "/ingest", { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + INGEST_TOKEN }, body: JSON.stringify(batch) });
    if (!r.ok) throw new Error("ingest " + r.status + " " + (await r.text()).slice(0, 200));
    n += batch.length; process.stdout.write(`  pushed ${n}/${records.length}\r`);
  }
  console.log(`\n  pushed ${n} records to ${WORKER_URL}`);
}
async function pushBloopers(bloopers) {
  if (!bloopers.length) return;
  // dedup by id (same Oid can appear if a facility was crawled twice)
  const seen = new Set(); let uniq = bloopers.filter((b) => !seen.has(b.id) && seen.add(b.id));
  // keep only the agent-curated "truly funny" set (ingest/bloopers_keep.json — IDs only) so a
  // fresh crawl doesn't repopulate the full unfiltered reel. Human-readable companion (why each
  // ID is kept: name/city/violation/narrative) lives in ingest/bloopers_keep.txt. Delete/empty
  // the .json to push everything.
  try {
    const keep = new Set(JSON.parse(readFileSync(join(HERE, "bloopers_keep.json"), "utf8")));
    if (keep.size) { const before = uniq.length; uniq = uniq.filter((b) => keep.has(b.id));
      console.log(`  blooper keep-list: ${uniq.length}/${before} retained`); }
  } catch {}
  await fetch(WORKER_URL + "/bloopers-reset", { method: "POST", headers: { "Authorization": "Bearer " + INGEST_TOKEN } });
  let n = 0;
  for (let i = 0; i < uniq.length; i += 200) {
    const batch = uniq.slice(i, i + 200);
    const r = await fetch(WORKER_URL + "/ingest-bloopers", { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + INGEST_TOKEN }, body: JSON.stringify(batch) });
    if (!r.ok) throw new Error("ingest-bloopers " + r.status + " " + (await r.text()).slice(0, 200));
    n += batch.length; process.stdout.write(`  pushed ${n}/${uniq.length} bloopers\r`);
  }
  console.log(`\n  pushed ${n} bloopers`);
}

async function main() {
  console.log("SnoKing Food Safety ingest", DRY ? "(dry run)" : "-> " + WORKER_URL);
  let recs = [], bloopers = [];
  if (!SNO_ONLY) { console.log("King County…"); recs.push(...(await king())); }
  if (!KING_ONLY) { console.log("Snohomish County…"); const sno = await snohomish(); bloopers = sno._bloopers || []; recs.push(...sno); }
  // apply cuisine overrides that the name-classifier can't produce: agent-curated business/
  // institutional cafeterias (Aerojet, Boeing, Microsoft cafés…) + Google Places cuisine types.
  // Keeps them across re-ingests.
  const ovMap = {};
  for (const f of ["other_reclass.json", "places_reclass.json", "places_reclass2.json"]) {
    try { JSON.parse(readFileSync(join(HERE, f), "utf8")).forEach((r) => (ovMap[r.id] = r.cuisine)); } catch {}
  }
  let nov = 0; for (const r of recs) if (ovMap[r.id]) { r.cuisine = ovMap[r.id]; nov++; }
  console.log(`  applied ${nov} cuisine overrides`);
  // tag census tracts now that all coords are known (Snohomish gets coords during geocoding)
  for (const r of recs) if (r.lat != null && r.lon != null && r.tract_id == null) r.tract_id = tagTract(r.lon, r.lat);
  const mappable = recs.filter((r) => r.lat != null && r.lon != null);
  const cdist = {}; recs.forEach((r) => (cdist[r.cuisine] = (cdist[r.cuisine] || 0) + 1));
  console.log(`Total: ${recs.length} establishments, ${mappable.length} mappable, ${bloopers.length} bloopers`);
  console.log("cuisine:", cdist);
  if (DRY) { writeFileSync(join(HERE, "data.json"), JSON.stringify(recs)); writeFileSync(join(HERE, "bloopers.json"), JSON.stringify(bloopers, null, 1)); console.log("wrote data.json + bloopers.json"); return; }
  if (!INGEST_TOKEN) { console.error("No INGEST_TOKEN (env or config.json). Use --dry to test."); process.exit(1); }
  await push(recs);
  await pushBloopers(bloopers);
}
main().catch((e) => { console.error("\nFAILED:", e.stack || e.message); process.exit(1); });
