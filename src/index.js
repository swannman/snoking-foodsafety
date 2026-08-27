// SnoKing Food Safety — Cloudflare Worker.
// Public restaurant food-safety map for King + Snohomish counties.
//   GET  /                      -> Leaflet map (left feed + filters + individual dots)
//   GET  /api/establishments    -> compact JSON of every mappable establishment (for map+list)
//   GET  /api/detail?id=        -> one establishment's violations + inspection history (popup, lazy)
//   GET  /api/stats             -> counts by county + rating + last update
//   GET  /streetview ?lat&lon   -> Google Street View Static (key stays server-side)
//   GET  /sv-embed   ?lat&lon   -> interactive 360 panorama (Embed API)
//   POST /ingest  (Bearer)      -> bulk upsert from the external ingester
// Secrets: INGEST_TOKEN, GOOGLE_KEY (optional — Street View is hidden without it).

import { sendPush } from "./webpush.js";
const RATING_LABEL = { 1: "Excellent", 2: "Good", 3: "Okay", 4: "Needs to Improve" };
// per-inspection rating from its violation points (lower=better); shared by both counties
const pointRating = (p) => (p == null || isNaN(p) ? null : p <= 0 ? 1 : p <= 15 ? 2 : p <= 35 ? 3 : 4);
// mean rating over the most recent N inspections (history is newest-first)
function avgRating(history, n = 5) {
  const rs = (history || []).map((h) => pointRating(h.score)).filter((r) => r != null).slice(0, n);
  return rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
}
// Infinite retention: union already-stored inspection history with a fresh county pull so
// records that have since aged out of the county API are never dropped. Dedup by date+service;
// the fresh copy wins on conflict (rescoring/corrections propagate). Newest-first, capped for
// row-size safety (200 inspections ≈ 30+ years — effectively unbounded for a real establishment).
function histKey(h) { return (h.date || "") + "|" + (h.svc || h.label || ""); }
function mergeHistory(prior, fresh) {
  const m = new Map();
  for (const h of prior || []) if (h && (h.date || h.svc || h.label)) m.set(histKey(h), h);
  for (const h of fresh || []) if (h && (h.date || h.svc || h.label)) m.set(histKey(h), h);  // fresh overwrites
  return [...m.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 200);
}
const isRoutine = (s) => /routine/i.test(s || "");
function ratingRoutineOf(h) { for (const x of h || []) if (isRoutine(x.svc)) { const r = pointRating(x.score); if (r != null) return r; } return null; }
function ratingWorstOf(h) { let w = null; for (const x of h || []) { const r = pointRating(x.score); if (r != null && (w == null || r > w)) w = r; } return w; }
function poorFracOf(h) { const s = (h || []).filter((x) => isRoutine(x.svc) && pointRating(x.score) != null); return s.length ? Math.round((s.filter((x) => pointRating(x.score) >= 3).length / s.length) * 1000) / 1000 : null; }
function worstPointsOf(h) { let w = null; for (const x of h || []) if (x.score != null && (w == null || x.score > w)) w = x.score; return w; }

// ── push notifications ────────────────────────────────────────────────────────
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// run a read-only Analytics Engine SQL query (AE_API_TOKEN = scoped "Account Analytics Read" token)
async function aeQuery(env, sql) {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/accounts/e586791371224fd8a71725fce7f6f1a6/analytics_engine/sql",
      { method: "POST", headers: { Authorization: "Bearer " + env.AE_API_TOKEN }, body: sql });
    if (!r.ok) return [];
    const j = await r.json();
    return j.data || [];
  } catch { return []; }
}
function buildPayload(chs) {
  const L = RATING_LABEL, dir = (c) => (c.pr == null ? "new" : c.r < c.pr ? "↑" : "↓");
  if (chs.length === 1) {
    const c = chs[0];
    return { title: "⭐ " + c.name, body: c.pr == null ? "New rating: " + L[c.r] : L[c.pr] + " → " + L[c.r] + " " + dir(c), url: "/?focus=" + encodeURIComponent(c.id) };
  }
  return { title: "⭐ " + chs.length + " favorites updated", body: chs.slice(0, 3).map((c) => c.name + " " + dir(c)).join(", ") + (chs.length > 3 ? "…" : ""), url: "/?changed=1" };
}
// Find newly-detected rating changes that someone favorited, send one batched push per subscriber,
// prune dead subscriptions, and mark the changes notified so they don't fire twice.
async function dispatchPush(env) {
  const { results: changes } = await env.DB.prepare(
    `SELECT e.id, e.name, e.prev_rating AS pr, e.rating AS r, e.change_svc AS cs
     FROM establishments e
     WHERE e.change_detected_at IS NOT NULL AND (e.notified_at IS NULL OR e.notified_at < e.change_detected_at)
       AND e.rating IS NOT e.prev_rating   -- never notify when the new rating equals the old one (keeps first-rating "new", where prev is null)
       AND EXISTS (SELECT 1 FROM push_favorites f WHERE f.est_id = e.id)`
  ).all();
  if (!changes || !changes.length) return { changes: 0, subscribers: 0, sent: 0, dead: 0 };
  const bySub = new Map();
  for (const ch of changes) {
    const { results: subs } = await env.DB.prepare("SELECT sub_id FROM push_favorites WHERE est_id=?").bind(ch.id).all();
    for (const s of subs || []) (bySub.get(s.sub_id) || bySub.set(s.sub_id, []).get(s.sub_id)).push(ch);
  }
  let sent = 0, dead = 0;
  for (const subId of bySub.keys()) {
    const row = await env.DB.prepare("SELECT endpoint,p256dh,auth FROM push_subs WHERE id=?").bind(subId).first();
    if (!row) continue;
    let status; try { status = await sendPush({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, buildPayload(bySub.get(subId)), env); } catch { status = 0; }
    if (status === 201 || status === 200) sent++;
    else if (status === 404 || status === 410) { dead++; await env.DB.batch([env.DB.prepare("DELETE FROM push_favorites WHERE sub_id=?").bind(subId), env.DB.prepare("DELETE FROM push_subs WHERE id=?").bind(subId)]); }
    else await env.DB.prepare("UPDATE push_subs SET fail_count=fail_count+1 WHERE id=?").bind(subId).run();
  }
  // mark ALL freshly-detected changes processed (even ones nobody favorited yet), so favoriting a
  // place later never triggers a push about a change that already happened.
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE establishments SET notified_at=? WHERE change_detected_at IS NOT NULL AND (notified_at IS NULL OR notified_at < change_detected_at)").bind(now).run();
  return { changes: changes.length, subscribers: bySub.size, sent, dead };
}

// Read endpoints are immutable per data version (client appends ?v=<updated_at>), so they're
// safe to store in Cloudflare's edge cache. Without this every unique visitor re-runs the
// full-table scans against D1; with it, the Worker touches D1 only on the first request per
// version per colo — repeat & shared traffic is served from cache for ~0 D1 rows read.
const CACHEABLE = new Set(["/api/establishments", "/api/points", "/api/region-stats", "/api/stats", "/api/bloopers", "/regions.geojson"]);
function cachePut(req, ctx, resp) {
  try { if (resp && resp.ok && ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(req, resp.clone())); } catch {}
  return resp;
}

// ── map-payload snapshots (KV) ────────────────────────────────────────────────
// /api/establishments and /api/points each scan all ~14k rows. Under a cold-cache burst
// (post-deploy, post-ingest version bump, or a crawl wave) many concurrent requests hit
// that D1 scan at once → contention → 504s. So the ingester prebuilds these payloads into
// KV once per refresh, and the hot path serves straight from KV (no D1 scan). Bump SNAP_VER
// whenever the item shape below changes — the new key misses, so the handler rebuilds from D1.
const SNAP_VER = "1";
const SNAP_EST = "snap:establishments:" + SNAP_VER, SNAP_PTS = "snap:points:" + SNAP_VER;
async function buildEstablishments(env) {
  const { results } = await env.DB.prepare(
    `SELECT id,county,name,address,city,zip,lat,lon,cuisine,rating,rating_avg,rating_routine,rating_worst,poor_frac,worst_points,grade,score,result,inspect_date,first_date,prev_rating,rating_changed_at,change_svc,delisted_at
     FROM establishments WHERE lat IS NOT NULL AND lon IS NOT NULL`
  ).all();
  const items = (results || []).map((r) => ({
    id: r.id, co: r.county === "king" ? "k" : "s", n: r.name, a: r.address, ci: r.city, z: r.zip,
    la: r.lat, lo: r.lon, cu: r.cuisine, r: r.rating, ra: r.rating_avg, rr: r.rating_routine, rw: r.rating_worst, pf: r.poor_frac, wp: r.worst_points,
    g: r.grade, s: r.score, rs: r.result, d: r.inspect_date, fd: r.first_date, pr: r.prev_rating, cd: r.rating_changed_at, cs: r.change_svc,
    ...(r.delisted_at ? { dl: r.delisted_at } : {}),
  }));
  const upd = await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first();
  return { updated: upd?.u ?? null, count: items.length, items };
}
async function buildPoints(env) {
  const { results } = await env.DB.prepare(
    `SELECT name,lat,lon,cuisine,rating,rating_avg,rating_avg_all,tract_id
     FROM establishments WHERE lat IS NOT NULL AND lon IS NOT NULL`
  ).all();
  const items = (results || []).map((r) => ({ n: r.name, la: r.lat, lo: r.lon, cu: r.cuisine, r: r.rating, ra: r.rating_avg, aa: r.rating_avg_all, t: r.tract_id }));
  const upd = await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first();
  return { updated: upd?.u ?? null, items };
}
// serve a KV snapshot; on miss, build from D1 and populate KV (self-healing first-request fallback)
async function serveSnapshot(req, ctx, env, key, build) {
  let body = await env.REGIONS.get(key);
  if (!body) { body = JSON.stringify(await build(env)); if (ctx && ctx.waitUntil) ctx.waitUntil(env.REGIONS.put(key, body)); }
  return cachePut(req, ctx, new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" } }));
}

// apex snoking.app is just a branded splash — the actual apps live on subdomains (food., dispatch.)
const APEX_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F6EFE8">
<link rel="icon" type="image/png" href="/icon-192.png?v=7">
<title>SnoKing</title>
<style>
  html,body{margin:0;height:100%;background:#F6EFE8}
  body{display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
  a{display:flex;line-height:0}
  img{width:auto;height:auto;max-width:min(600px,92vw);max-height:92vh}
</style></head>
<body><a href="https://food.snoking.app/" aria-label="SnoKing Food Safety map"><img src="/snoking.jpg" alt="SnoKing — Snohomish &amp; King County restaurant food-safety ratings"></a></body></html>`;

// ── server-rendered per-restaurant pages (SEO) ────────────────────────────────
const LBL = { 1: "Excellent", 2: "Good", 3: "Okay", 4: "Needs to Improve", 0: "Unrated" };
const COL = { 1: "#2ecc71", 2: "#a8c800", 3: "#f0a020", 4: "#e5484d", 0: "#7d8590" };
const hesc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const slugify = (s) => (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)) || "place";
const idKey = (id) => id.replace(":", ".");                 // "sno:FA123" -> "sno.FA123" (URL-clean; ids have no dots)
const restPath = (r) => "/r/" + idKey(r.id) + "/" + slugify(r.name + "-" + r.city);
function restaurantHtml(r) {
  let det = {}; try { det = JSON.parse(r.detail || "{}"); } catch {}
  const rating = r.rating || 0, label = LBL[rating] || "Unrated", color = COL[rating] || COL[0];
  const cityC = titleCase(r.city), county = r.county === "king" ? "King County" : "Snohomish County";
  const addr = [r.address, cityC, "WA", r.zip].filter(Boolean).join(", ");
  const canonical = "https://food.snoking.app" + restPath(r);
  const title = `${r.name} — Health Inspection Rating (${cityC}) | Sno/King Food Safety`;
  // The county stopped listing this one. Everything below is the LAST rating we captured, not a
  // current one — say so in the description and on the page rather than presenting a stale grade as live.
  const dl = r.delisted_at || null;
  const desc = dl
    ? `${r.name} at ${addr} is no longer listed by ${county}. Last recorded food-safety rating "${label}" — see the full inspection history and violations we captured.`
    : `${r.name} at ${addr}: current food-safety rating "${label}". See the full inspection history and violations from ${county} health-department records.`;
  const hist = (det.history || []).slice(0, 20).map((h) =>
    `<tr><td>${hesc(h.date || "")}</td><td>${hesc(h.label || "")}</td><td>${h.score != null ? h.score + " pts" : ""}</td></tr>`).join("");
  const recent = (det.violations || []).slice(0, 12).map((v) => `<li>${hesc(v.label || "")}</li>`).join("");
  const ld = { "@context": "https://schema.org", "@type": "Restaurant", name: r.name, url: canonical,
    address: { "@type": "PostalAddress", streetAddress: r.address || undefined, addressLocality: cityC, addressRegion: "WA", postalCode: r.zip || undefined, addressCountry: "US" } };
  if (r.lat != null && r.lon != null) ld.geo = { "@type": "GeoCoordinates", latitude: r.lat, longitude: r.lon };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${hesc(title)}</title>
<meta name="description" content="${hesc(desc)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="/icon-192.png?v=7">
<link rel="apple-touch-icon" href="/icon-180.png?v=7">
<meta name="theme-color" content="#0d1117">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sno/King Food Safety">
<meta property="og:title" content="${hesc(r.name + " — Health Inspection Rating")}">
<meta property="og:description" content="${hesc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://food.snoking.app/snoking.jpg">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0d1117;color:#e6edf3;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:720px;margin:0 auto;padding:26px 20px 64px}
  a{color:#58a6ff}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
  h2{font-size:16px;margin:26px 0 6px}
  .addr{color:#8b949e;margin-bottom:14px}
  .badge{display:inline-block;padding:3px 12px;border-radius:999px;font-weight:700;color:#0d1117}
  table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}
  th,td{border-bottom:1px solid #2a3038;padding:6px 8px;text-align:left}
  th{color:#8b949e;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  ul{padding-left:20px;color:#c9d2dc}
  li{margin:3px 0}
  .cta{display:inline-block;margin:8px 12px 4px 0;padding:9px 15px;border:1px solid #2a3038;border-radius:8px;text-decoration:none;font-weight:600}
  .muted{color:#8b949e;font-size:13px}
  .gone{background:#1b2027;border:1px solid #2a3038;border-radius:8px;padding:10px 12px;margin:10px 0;color:#c9d2dc;font-size:14px}
  .tag{display:inline-block;padding:3px 10px;border-radius:999px;background:#6e7681;color:#fff;font-weight:700;font-size:13px;margin-left:6px}
</style></head>
<body><div class="wrap">
  <p class="muted"><a href="/">Map</a> · <a href="/browse">Browse</a> · <a href="/browse/${r.county}/${slugify(r.city || "")}">${hesc(cityC)}</a></p>
  <h1>${hesc(r.name)}</h1>
  <div class="addr">${hesc(addr)} · ${county}</div>
  <p><span class="badge" style="background:${color}">${label}</span>${dl ? `<span class="tag">Closed</span>` : ""}</p>
  ${dl ? `<div class="gone">⚠︎ No longer listed by ${county} (since ${hesc(String(dl).slice(0, 10))}). It may have closed or changed ownership — the rating and history below are what we last captured, not a current inspection.</div>` : ""}
  ${r.score != null ? `<p><b>${r.county === "king" ? "Inspection score" : "Violation points"}:</b> ${r.score} <span class="muted">(lower is better)</span></p>` : ""}
  <p><a class="cta" href="https://food.snoking.app/?focus=${encodeURIComponent(r.id)}">View on the map →</a>${r.report_url && !dl ? `<a class="cta" href="${hesc(r.report_url)}" rel="noopener">Official county report →</a>` : ""}</p>
  ${recent ? `<h2>Most recent violations</h2><ul>${recent}</ul>` : ""}
  ${hist ? `<h2>Inspection history</h2><table><tr><th>Date</th><th>Result</th><th>Points</th></tr>${hist}</table>` : ""}
  <p class="muted">Ratings are derived from public ${county} health-department inspection records. For authoritative information, use the official report linked above.</p>
</div></body></html>`;
}

// ── browsable HTML directory (county → city → restaurant) ─────────────────────
// Crawlable internal links into every /r/ page. Fixes Search Console "Discovered –
// currently not indexed": the restaurant pages were orphaned (reachable only via the
// sitemap), so Google deprioritized crawling them. These directory pages give Googlebot
// real crawl paths and flow link-equity from the homepage down to the leaf pages.
const CO_NAME = { king: "King County", snohomish: "Snohomish County" };
function browseShell(title, desc, path, body) {
  const canonical = "https://food.snoking.app" + path;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${hesc(title)}</title>
<meta name="description" content="${hesc(desc)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="/icon-192.png?v=7">
<meta name="theme-color" content="#0d1117">
<meta property="og:type" content="website"><meta property="og:site_name" content="Sno/King Food Safety">
<meta property="og:title" content="${hesc(title)}"><meta property="og:description" content="${hesc(desc)}">
<meta property="og:url" content="${canonical}"><meta property="og:image" content="https://food.snoking.app/snoking.jpg">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0d1117;color:#e6edf3;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:24px 20px 64px}
  a{color:#58a6ff;text-decoration:none} a:hover{text-decoration:underline}
  h1{font-size:25px;margin:0 0 6px;letter-spacing:-.01em}
  h2{font-size:17px;margin:24px 0 8px}
  .crumb,.muted{color:#8b949e;font-size:13px}
  .crumb{margin-bottom:14px}
  ul.cols{columns:2;column-gap:26px;padding-left:18px;margin:6px 0}
  @media(min-width:660px){ul.cols{columns:3}}
  li{margin:2px 0;break-inside:avoid}
  .cnt{color:#8b949e;font-size:12px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
</style></head>
<body><div class="wrap">${body}
  <p class="muted" style="margin-top:34px">Ratings are derived from public King &amp; Snohomish County health-department inspection records. <a href="/">Open the map →</a></p>
</div></body></html>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // apex host -> branded splash page (assets like /snoking.jpg are still served from the edge)
    if (url.hostname === "snoking.app" && url.pathname === "/")
      return new Response(APEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });

    // server-rendered per-restaurant page (SEO): /r/<idkey>[/<slug>]
    if (url.pathname.startsWith("/r/")) {
      const idkey = decodeURIComponent(url.pathname.slice(3).split("/")[0]);
      const id = idkey.replace(/\./, ":");
      const row = await env.DB.prepare("SELECT id,county,name,address,city,zip,lat,lon,rating,score,report_url,detail,delisted_at FROM establishments WHERE id=?").bind(id).first();
      if (!row) return new Response("Restaurant not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      return new Response(restaurantHtml(row), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }

    // browse index: every city in both counties, linked (crawl path into the /r/ leaf pages)
    if (url.pathname === "/browse" || url.pathname === "/browse/") {
      const hit = await caches.default.match(req).catch(() => null); if (hit) return hit;
      const { results } = await env.DB.prepare(
        "SELECT county, city, COUNT(*) AS n FROM establishments WHERE city IS NOT NULL AND city != '' GROUP BY county, city"
      ).all();
      const byCo = { king: [], snohomish: [] };
      for (const r of results || []) if (byCo[r.county]) byCo[r.county].push(r);
      for (const k in byCo) byCo[k].sort((a, b) => titleCase(a.city).localeCompare(titleCase(b.city)));
      let body = `<h1>Browse restaurants by city</h1>
        <p class="muted">Every restaurant in King &amp; Snohomish County, WA, grouped by city. Tap a city for its food-safety inspection ratings, history, and violations.</p>`;
      for (const co of ["king", "snohomish"]) {
        if (!byCo[co].length) continue;
        body += `<h2>${CO_NAME[co]}</h2><ul class="cols">`;
        for (const r of byCo[co]) body += `<li><a href="/browse/${co}/${slugify(r.city)}">${hesc(titleCase(r.city))}</a> <span class="cnt">${r.n}</span></li>`;
        body += `</ul>`;
      }
      const html = browseShell("Browse Restaurants by City — Sno/King Food Safety",
        "Browse every restaurant in King & Snohomish County, WA by city. Food-safety inspection ratings, history, and violations for each place.",
        "/browse", body);
      const resp = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(req, resp.clone()));
      return resp;
    }
    // browse a single city: /browse/<county>/<city-slug> — plain links to every restaurant there
    if (url.pathname.startsWith("/browse/")) {
      const parts = url.pathname.slice(8).split("/").filter(Boolean);
      const co = parts[0], citySlug = parts[1];
      if (!CO_NAME[co] || !citySlug) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      const hit = await caches.default.match(req).catch(() => null); if (hit) return hit;
      const { results: cities } = await env.DB.prepare(
        "SELECT DISTINCT city FROM establishments WHERE county = ? AND city IS NOT NULL AND city != ''").bind(co).all();
      const matches = (cities || []).map((c) => c.city).filter((c) => slugify(c) === citySlug);
      if (!matches.length) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      const ph = matches.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT id, name, city, rating FROM establishments WHERE county = ? AND city IN (${ph}) ORDER BY name`
      ).bind(co, ...matches).all();
      const cityC = titleCase(matches[0]);
      let body = `<div class="crumb"><a href="/browse">Browse</a> › ${CO_NAME[co]} › ${hesc(cityC)}</div>
        <h1>Restaurants in ${hesc(cityC)}, WA</h1>
        <p class="muted">${(results || []).length} restaurants in ${hesc(cityC)} — ${CO_NAME[co]} food-safety inspection ratings.</p>
        <ul class="cols">`;
      for (const r of results || []) body += `<li><span class="dot" style="background:${COL[r.rating || 0]}"></span><a href="${restPath(r)}">${hesc(titleCase(r.name))}</a></li>`;
      body += `</ul>`;
      const html = browseShell(`Restaurants in ${cityC}, WA — Food Safety Ratings | Sno/King`,
        `Food-safety inspection ratings for every restaurant in ${cityC}, WA (${CO_NAME[co]}). Ratings, inspection history, and violations.`,
        `/browse/${co}/${citySlug}`, body);
      const resp = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(req, resp.clone()));
      return resp;
    }

    // sitemap of every restaurant page (cached hard — one full scan per day per colo)
    if (url.pathname === "/sitemap.xml") {
      const hit = await caches.default.match(req).catch(() => null); if (hit) return hit;
      const { results } = await env.DB.prepare("SELECT id,name,city,county,updated_at FROM establishments").all();
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
      for (const p of ["", "about", "stats", "bloopers", "browse"]) xml += `<url><loc>https://food.snoking.app/${p}</loc></url>`;
      // browse-by-city pages (crawl paths into the leaf pages)
      const cityset = new Set();
      for (const r of results || []) if (r.city) cityset.add(r.county + "/" + slugify(r.city));
      for (const c of cityset) xml += `<url><loc>https://food.snoking.app/browse/${c}</loc></url>`;
      // per-restaurant pages, with lastmod so Google can prioritize freshly-updated records
      for (const r of results || []) {
        const lm = (r.updated_at || "").slice(0, 10);
        xml += `<url><loc>https://food.snoking.app${restPath(r)}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`;
      }
      xml += `</urlset>`;
      const resp = new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(req, resp.clone()));
      return resp;
    }

    if (req.method === "GET" && CACHEABLE.has(url.pathname)) {
      const hit = await caches.default.match(req).catch(() => null);
      if (hit) return hit;
    }

    // PWA manifest, icons, and the service worker are now static files in /public, served
    // straight from Cloudflare's edge (no Worker invocation) — see public/ + [assets] in wrangler.toml.

    if (url.pathname === "/ev" && req.method === "POST") {
      // anonymous product-usage event: {n: name, l: label, l2/l3: extra dimensions}. No user PII;
      // l2/l3 carry public business attrs (cuisine, restaurant name) for "what do people check" breakdowns.
      try { const b = JSON.parse(await req.text());
        const n = String(b.n || "").slice(0, 40), l = String(b.l || "").slice(0, 80), l2 = String(b.l2 || "").slice(0, 40), l3 = String(b.l3 || "").slice(0, 90);
        if (n && env.AE) env.AE.writeDataPoint({ indexes: [n], blobs: [n, l, l2, l3] }); } catch {}
      return new Response(null, { status: 204 });
    }

    // ── token-gated analytics dashboard ──
    if (url.pathname === "/dashboard") {
      return new Response(DASH_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (url.pathname === "/dash/data") {
      // read-only endpoint: accept the dedicated dashboard token, or the ingest token as a fallback
      const auth = req.headers.get("Authorization") || "";
      const ok = (env.DASH_TOKEN && auth === "Bearer " + env.DASH_TOKEN) || auth === "Bearer " + env.INGEST_TOKEN;
      if (!ok) return new Response("unauthorized", { status: 401 });
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10) || 7));
      const since = `now() - INTERVAL '${days}' DAY`;
      // Analytics Engine stores UTC and toDate() takes no timezone arg, so bucket the daily chart by
      // Pacific date by shifting the timestamp by the CURRENT Pacific offset (7h PDT / 8h PST — auto).
      const nowD = new Date();
      const pacOff = Math.round((new Date(nowD.toLocaleString("en-US", { timeZone: "UTC" })) - new Date(nowD.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))) / 3600000);
      const Q = {
        daily: `SELECT toDate(timestamp - INTERVAL '${pacOff}' HOUR) AS k, sum(if(blob1='app',_sample_interval,0)) AS sessions, sum(if(blob1='open',_sample_interval,0)) AS opens, sum(_sample_interval) AS events FROM snoking_events WHERE timestamp > ${since} GROUP BY k ORDER BY k`,
        byType: `SELECT blob1 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1 NOT IN ('ref','src') AND timestamp > ${since} GROUP BY k ORDER BY v DESC`,
        referrers: `SELECT blob2 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='ref' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 15`,
        src: `SELECT blob2 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='src' AND blob2!='' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 25`,
        shade: `SELECT blob2 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='shade' AND timestamp > ${since} GROUP BY k ORDER BY v DESC`,
        cuisine: `SELECT blob2 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='filter' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 15`,
        county: `SELECT blob2 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='open' AND timestamp > ${since} GROUP BY k ORDER BY v DESC`,
        openCuisine: `SELECT blob3 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='open' AND blob3!='' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 20`,
        openRestK: `SELECT blob4 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='open' AND blob2='k' AND blob4!='' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 30`,
        openRestS: `SELECT blob4 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='open' AND blob2='s' AND blob4!='' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 30`,
        savedRest: `SELECT blob4 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='fav' AND blob2='add' AND blob4!='' AND timestamp > ${since} GROUP BY k ORDER BY v DESC LIMIT 25`,
        install: `SELECT blob2 AS k, sum(_sample_interval) AS v FROM snoking_events WHERE blob1='app' AND timestamp > ${since} GROUP BY k ORDER BY v DESC`,
        hourly: `SELECT toStartOfHour(timestamp) AS k, sum(if(blob1='app',_sample_interval,0)) AS sessions, sum(if(blob1='open',_sample_interval,0)) AS opens FROM snoking_events WHERE timestamp > now() - INTERVAL '2' DAY GROUP BY k ORDER BY k`
      };
      const keys = Object.keys(Q), out = {};
      const rs = await Promise.all(keys.map((k) => aeQuery(env, Q[k])));
      keys.forEach((k, i) => { out[k] = rs[i]; });
      // the analytics events only carry the restaurant NAME, so look up rating + city from D1
      // (by name) for the most-checked / most-saved panels — lets us see if rating biases checks.
      try {
        const names = [...new Set([...(out.openRestK || []), ...(out.openRestS || []), ...(out.savedRest || [])].map((r) => r.k).filter(Boolean))];
        if (names.length) {
          const ph = names.map(() => "?").join(",");
          const { results } = await env.DB.prepare(`SELECT id, name, rating, city, county FROM establishments WHERE name IN (${ph})`).bind(...names).all();
          // disambiguate same-named places by county (the open event carries it); savedRest has no county -> name-only
          const byNC = {}, byN = {};
          for (const row of results || []) {
            const v = { id: row.id, rating: row.rating, city: row.city };
            const kc = row.name + "|" + row.county; if (byNC[kc] == null) byNC[kc] = v;
            if (byN[row.name] == null) byN[row.name] = v;
          }
          const attach = (rows, county) => (rows || []).map((r) => { const m = (county && byNC[r.k + "|" + county]) || byN[r.k] || {}; return { ...r, id: m.id ?? null, rating: m.rating ?? null, city: m.city ?? null }; });
          out.openRestK = attach(out.openRestK, "king"); out.openRestS = attach(out.openRestS, "snohomish"); out.savedRest = attach(out.savedRest, null);
        }
      } catch {}
      return Response.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      const sub = b && b.subscription, favs = Array.isArray(b && b.favorites) ? b.favorites : [];
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return new Response("bad subscription", { status: 400 });
      const id = await sha256hex(sub.endpoint), now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO push_subs (id,endpoint,p256dh,auth,created_at,last_seen,fail_count) VALUES (?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,last_seen=excluded.last_seen,fail_count=0")
        .bind(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now, now).run();
      await env.DB.prepare("DELETE FROM push_favorites WHERE sub_id=?").bind(id).run();
      const clean = favs.filter((x) => typeof x === "string").slice(0, 500);
      const stmts = clean.map((est) => env.DB.prepare("INSERT OR IGNORE INTO push_favorites (sub_id,est_id) VALUES (?,?)").bind(id, est));
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      return Response.json({ ok: true, favorites: clean.length });
    }
    if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!b || !b.endpoint) return new Response("bad request", { status: 400 });
      const id = await sha256hex(b.endpoint);
      await env.DB.batch([env.DB.prepare("DELETE FROM push_favorites WHERE sub_id=?").bind(id), env.DB.prepare("DELETE FROM push_subs WHERE id=?").bind(id)]);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/push/dispatch" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN) return new Response("unauthorized", { status: 401 });
      return Response.json(await dispatchPush(env));
    }
    if (url.pathname === "/push/test" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN) return new Response("unauthorized", { status: 401 });
      let b; try { b = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!b.subscription) return new Response("need subscription", { status: 400 });
      const status = await sendPush(b.subscription, b.payload || { title: "Sno/King test 🔔", body: "Push notifications are working.", url: "/" }, env);
      return Response.json({ status });
    }

    if (url.pathname === "/ingest" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      let recs;
      try { recs = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(recs)) return new Response("expected array", { status: 400 });
      const now = new Date().toISOString();
      const batch = recs.slice(0, 1000);
      // infinite retention: pull the history we already stored for these ids and union it with the
      // fresh pull, so inspections that have since aged out of the county API are preserved forever.
      const priorHist = new Map();
      const ids = batch.map((r) => r.id).filter(Boolean);
      for (let i = 0; i < ids.length; i += 90) {   // D1 caps bound params at 100
        const chunk = ids.slice(i, i + 90);
        const { results: rows } = await env.DB.prepare(
          `SELECT id, detail FROM establishments WHERE id IN (${chunk.map(() => "?").join(",")})`
        ).bind(...chunk).all();
        for (const row of rows || []) {
          try { const d = JSON.parse(row.detail || "{}"); if (Array.isArray(d.history) && d.history.length) priorHist.set(row.id, d.history); } catch {}
        }
      }
      for (const r of batch) {
        if (r && typeof r.detail === "object" && r.detail && Array.isArray(r.detail.history)) {
          const prev = priorHist.get(r.id);
          if (prev && prev.length) r.detail = { ...r.detail, history: mergeHistory(prev, r.detail.history) };
        }
      }
      const stmts = batch.map((r) =>
        env.DB.prepare(
          `INSERT INTO establishments
             (id,county,name,address,city,zip,lat,lon,cuisine,rating,rating_label,grade,score,result,inspect_date,first_date,report_url,detail,rating_avg,rating_avg_all,rating_routine,rating_worst,poor_frac,worst_points,tract_id,prev_rating,rating_changed_at,change_svc,change_detected_at,notified_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             county=excluded.county, name=excluded.name, address=excluded.address, city=excluded.city,
             zip=excluded.zip, lat=excluded.lat, lon=excluded.lon, cuisine=excluded.cuisine,
             rating_label=excluded.rating_label, grade=excluded.grade, score=excluded.score, result=excluded.result,
             inspect_date=excluded.inspect_date, first_date=excluded.first_date, report_url=excluded.report_url,
             detail=excluded.detail, rating_avg=excluded.rating_avg, rating_avg_all=excluded.rating_avg_all,
             rating_routine=excluded.rating_routine, rating_worst=excluded.rating_worst, poor_frac=excluded.poor_frac, worst_points=excluded.worst_points, tract_id=excluded.tract_id, updated_at=excluded.updated_at,
             -- track rating changes: when the rating actually moves, remember the prior value and
             -- stamp the change with the new inspection date (these RHS see the OLD row in SQLite,
             -- so this is evaluated before rating itself is overwritten on the next line)
             prev_rating=CASE WHEN excluded.rating IS NOT establishments.rating THEN establishments.rating ELSE establishments.prev_rating END,
             rating_changed_at=CASE WHEN excluded.rating IS NOT establishments.rating THEN excluded.inspect_date ELSE establishments.rating_changed_at END,
             change_svc=CASE WHEN excluded.rating IS NOT establishments.rating THEN excluded.change_svc ELSE establishments.change_svc END,
             change_detected_at=CASE WHEN excluded.rating IS NOT establishments.rating THEN excluded.updated_at ELSE establishments.change_detected_at END,
             delisted_at=NULL,   -- present in this crawl => currently listed (clears any prior delist / resets the 6-month clock)
             rating=excluded.rating`
        ).bind(
          r.id, r.county, r.name, r.address ?? null, r.city ?? null, r.zip ?? null, r.lat ?? null, r.lon ?? null,
          r.cuisine ?? null, r.rating ?? null, r.rating != null ? RATING_LABEL[r.rating] ?? null : null,
          r.grade ?? null, r.score ?? null, r.result ?? null, r.inspect_date ?? null, r.first_date ?? null,
          r.report_url ?? null, typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail ?? {}),
          r.rating_avg ?? avgRating((typeof r.detail === "object" ? r.detail : {}).history),
          r.rating_avg_all ?? avgRating((typeof r.detail === "object" ? r.detail : {}).history, 99),
          r.rating_routine ?? r.rating ?? null, r.rating_worst ?? r.rating ?? null, r.poor_frac ?? null, r.worst_points ?? null, r.tract_id ?? null,
          null, r.inspect_date ?? null, r.rating_svc ?? null, now, null, now
        )
      );
      for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25));
      return Response.json({ ok: true, n: stmts.length });
    }

    if (url.pathname === "/reconcile-delisted" && req.method === "POST") {
      // Called after a FULL county crawl with the complete set of currently-listed ids. A stored row
      // for that county that ISN'T in the set went missing for one of three very different reasons:
      //
      //   1. `absorbed` (optional, {oldId: survivingId}) — the ingester's permit merge folded this
      //      permit into a sibling record for the SAME business. The business is open and still on
      //      the map under the surviving id; this row is a duplicate pin. Delete it now, and move
      //      any favorites to the survivor. Labelling it "Closed" would be a lie, and leaving it is
      //      the ghost-duplicate bug (stacked pins frozen at an old rating).
      //   2. `keep` (optional, [id]) — the county still publishes this business as open; it dropped
      //      out of the crawl because of OUR filters (no usable rating, missing coordinates), not
      //      because it disappeared. Leave the row exactly as it is. "Closed" is a claim the source
      //      data contradicts, and a business quietly going 18 months between inspections must not
      //      be enough to make us assert it.
      //   3. everything else — it vanished from the source portal. Mark it delisted (shows a
      //      "Closed" badge, keeps its last rating); after >6 months continuously gone it's deleted.
      //
      // Re-appearing clears the delist flag (handled by /ingest above).
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      let body; try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      const county = body && body.county, live = new Set((body && body.ids) || []);
      const dry = !!(body && body.dry);   // classify + report, write nothing (for verifying a change before it deletes)
      if (!county || !live.size) return new Response("need county + non-empty ids", { status: 400 });
      // an id can't be both live and absorbed; if a buggy caller says so, "live" wins (never delete)
      const absorbed = new Map();
      for (const [k, v] of Object.entries((body && body.absorbed) || {}))
        if (!live.has(k) && v && v !== k) absorbed.set(k, v);
      // spared ids (see 2 above). Checked BEFORE `absorbed` below: if the merge somehow claims an id
      // the county still lists on its own, the non-destructive reading wins.
      const keep = new Set((body && body.keep) || []);
      const have = (await env.DB.prepare("SELECT COUNT(*) AS n FROM establishments WHERE county=?").bind(county).first())?.n || 0;
      // guard: a truncated crawl must never mass-delist. Require the live set to cover most of what we have.
      if (live.size < have * 0.7) return Response.json({ skipped: true, reason: "live set too small", live: live.size, have });
      const { results } = await env.DB.prepare("SELECT id, delisted_at FROM establishments WHERE county=?").bind(county).all();
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - 183 * 86400000).toISOString();   // ~6 months
      const toMark = [], toDelete = [], toAbsorb = [];
      let kept = 0;
      for (const row of results || []) {
        if (live.has(row.id)) continue;                       // still listed — nothing to do (clear handled by /ingest)
        if (keep.has(row.id)) { kept++; continue; }           // county still calls it open — don't touch it
        if (absorbed.has(row.id)) { toAbsorb.push(row); continue; }   // merge artifact, not a closure
        if (!row.delisted_at) toMark.push(row.id);            // newly vanished — start the clock
        else if (row.delisted_at < cutoff) toDelete.push(row.id);   // gone >6 months — remove
      }
      // second guard, for the delete-now path specifically: a merge that suddenly claims to absorb a
      // big slice of the county is a bug, not 700 restaurants sharing a permit. Skip the sweep, keep
      // the delist path working, and report it so the ingest log shows something went wrong.
      let absorbedSkipped = null;
      if (toAbsorb.length > Math.max(50, have * 0.1)) {
        absorbedSkipped = `${toAbsorb.length} absorbed ids exceeds 10% of ${have}`;
        toAbsorb.length = 0;
      }
      const chunk = (arr, sql, extra) => { for (let i = 0; i < arr.length; i += 90) { const c = arr.slice(i, i + 90);
        stmtsQ.push(env.DB.prepare(sql.replace("(?)", "(" + c.map(() => "?").join(",") + ")")).bind(...(extra || []), ...c)); } };
      const stmtsQ = [];
      // Re-point favorites before deleting the row they reference, so a saved restaurant survives a
      // permit renumbering instead of silently falling off someone's alert list. Look up which
      // absorbed ids are actually favorited first — that's nearly always none, and it keeps this
      // from emitting two statements per absorbed row every single run.
      const absorbedIds = toAbsorb.map((r) => r.id);
      const favIds = [];
      for (let i = 0; i < absorbedIds.length; i += 90) {   // same 90-param chunking as the writes below
        const c = absorbedIds.slice(i, i + 90);
        const { results: fr } = await env.DB.prepare(`SELECT DISTINCT est_id FROM push_favorites WHERE est_id IN (${c.map(() => "?").join(",")})`).bind(...c).all();
        for (const row of fr || []) favIds.push(row.est_id);
      }
      // INSERT OR IGNORE first (the sub may already favorite the survivor), then drop the old pair —
      // order matters, and (sub_id, est_id) is the primary key so duplicates can't form.
      for (const id of favIds) {
        stmtsQ.push(env.DB.prepare("INSERT OR IGNORE INTO push_favorites (sub_id, est_id) SELECT sub_id, ? FROM push_favorites WHERE est_id=?").bind(absorbed.get(id), id));
        stmtsQ.push(env.DB.prepare("DELETE FROM push_favorites WHERE est_id=?").bind(id));
      }
      chunk(absorbedIds, "DELETE FROM establishments WHERE id IN (?)");
      chunk(toMark, "UPDATE establishments SET delisted_at=?, updated_at=? WHERE id IN (?)", [now, now]);
      chunk(toDelete, "DELETE FROM establishments WHERE id IN (?)");
      if (!dry) for (let i = 0; i < stmtsQ.length; i += 20) await env.DB.batch(stmtsQ.slice(i, i + 20));
      return Response.json({ ok: true, county, live: live.size, have, marked: toMark.length, deleted: toDelete.length,
        absorbedDeleted: toAbsorb.length, favoritesRemapped: favIds.length, kept, ...(absorbedSkipped ? { absorbedSkipped } : {}),
        ...(dry ? { dry: true, absorbedIds, markedIds: toMark, deleteIds: toDelete } : {}) });
    }

    if (url.pathname === "/rebuild-snapshot" && req.method === "POST") {
      // rebuild the KV map-payload snapshots from D1 (called by the ingester after each refresh,
      // and safe to hit manually after a deploy). One D1 scan here per day instead of per request.
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      const est = await buildEstablishments(env), pts = await buildPoints(env);
      await env.REGIONS.put(SNAP_EST, JSON.stringify(est));
      await env.REGIONS.put(SNAP_PTS, JSON.stringify(pts));
      return Response.json({ ok: true, establishments: est.count, points: pts.items.length, updated: est.updated, ver: SNAP_VER });
    }

    if (url.pathname === "/set-cuisine" && req.method === "POST") {
      // fast cuisine-only update (recompute from name without a full re-ingest/re-crawl)
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      let recs;
      try { recs = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(recs)) return new Response("expected array", { status: 400 });
      const now = new Date().toISOString();   // bump so the cached ?v=<updated_at> busts
      const stmts = recs.map((r) => env.DB.prepare("UPDATE establishments SET cuisine=?, updated_at=? WHERE id=?").bind(r.cuisine, now, r.id));
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      return Response.json({ ok: true, n: stmts.length });
    }

    if (url.pathname === "/recompute-avg" && req.method === "POST") {
      // backfill rating_avg from each row's stored inspection history (no re-ingest needed)
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      let updated = 0;
      for (let off = 0; ; off += 2000) {
        const { results } = await env.DB.prepare("SELECT id, rating, detail FROM establishments ORDER BY id LIMIT 2000 OFFSET ?").bind(off).all();
        if (!results || !results.length) break;
        const stmts = [];
        const now = new Date().toISOString();
        for (const row of results) {
          let h = []; try { h = JSON.parse(row.detail || "{}").history || []; } catch {}
          stmts.push(env.DB.prepare("UPDATE establishments SET rating_avg=?, rating_avg_all=?, rating_routine=?, rating_worst=?, poor_frac=?, worst_points=?, updated_at=? WHERE id=?")
            .bind(avgRating(h, 5), avgRating(h, 99), ratingRoutineOf(h) ?? row.rating, ratingWorstOf(h) ?? row.rating, poorFracOf(h), worstPointsOf(h), now, row.id));
        }
        for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
        updated += results.length;
        if (results.length < 2000) break;
      }
      return Response.json({ ok: true, updated });
    }

    if (url.pathname === "/set-tract" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      let recs;
      try { recs = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(recs)) return new Response("expected array", { status: 400 });
      const now = new Date().toISOString();
      const stmts = recs.map((r) => env.DB.prepare("UPDATE establishments SET tract_id=?, updated_at=? WHERE id=?").bind(r.tract_id ?? null, now, r.id));
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      return Response.json({ ok: true, n: stmts.length });
    }

    if (url.pathname === "/bloopers-reset" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN) return new Response("unauthorized", { status: 401 });
      await env.DB.prepare("DELETE FROM bloopers").run();
      return Response.json({ ok: true });
    }
    // prune bloopers whose id isn't in the supplied keep-list — removes de-curated ones while KEEPING
    // curated bloopers whose source restaurant has since closed (they're anonymized quotes, still good)
    if (url.pathname === "/bloopers-prune" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN) return new Response("unauthorized", { status: 401 });
      let ids; try { ids = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(ids) || !ids.length) return new Response("expected non-empty id array", { status: 400 });
      // D1 caps bound params at 100, so compute the (usually tiny) to-delete set and delete it in chunks
      const keep = new Set(ids);
      const { results } = await env.DB.prepare("SELECT id FROM bloopers").all();
      const del = (results || []).map((r) => r.id).filter((id) => !keep.has(id));
      let removed = 0;
      for (let i = 0; i < del.length; i += 90) {
        const chunk = del.slice(i, i + 90), ph = chunk.map(() => "?").join(",");
        const r = await env.DB.prepare(`DELETE FROM bloopers WHERE id IN (${ph})`).bind(...chunk).run();
        removed += (r.meta && r.meta.changes) || 0;
      }
      return Response.json({ ok: true, removed });
    }
    if (url.pathname === "/ingest-bloopers" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN) return new Response("unauthorized", { status: 401 });
      let recs; try { recs = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(recs)) return new Response("expected array", { status: 400 });
      const stmts = recs.map((b) =>
        env.DB.prepare("INSERT OR REPLACE INTO bloopers (id,name,city,date,tag,label,text,report_url,lat,lon) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(b.id, b.name, b.city ?? null, b.date ?? null, b.tag ?? null, b.label ?? null, b.text, b.report_url ?? null, b.lat ?? null, b.lon ?? null));
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      return Response.json({ ok: true, n: stmts.length });
    }
    if (url.pathname === "/api/bloopers") {
      // de-identified: no name / report link / coords / facility id — just city + date + the narrative
      const { results } = await env.DB.prepare("SELECT city,date,tag,label,text FROM bloopers ORDER BY date DESC").all();
      return cachePut(req, ctx, Response.json({ count: (results || []).length, items: results || [] }, { headers: { "Cache-Control": "public, max-age=900" } }));
    }
    if (url.pathname === "/bloopers") {
      // stamp the data version so the client's /api/bloopers fetch is cache-busted whenever the
      // data is re-ingested (the API response stays hard-cached, keyed by ?v=<updated_at>)
      const v = (await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first())?.u || "0";
      return new Response(BLOOPERS_HTML.replace("__DATA_VERSION__", encodeURIComponent(v)), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (url.pathname === "/about") return new Response(ABOUT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });

    if (url.pathname === "/regions.geojson") {
      const geo = await env.REGIONS.get("regions.geojson");
      return geo ? cachePut(req, ctx, new Response(geo, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" } }))
                 : new Response("not found", { status: 404 });
    }

    if (url.pathname === "/api/region-stats") {
      // average rating + restaurant count per census tract (optionally one cuisine).
      // rating uses the 5-inspection average where available, else the latest rating.
      const cuisine = url.searchParams.get("cuisine");
      const basis = url.searchParams.get("basis");   // last | avg5 | all  (default avg5)
      const expr = basis === "last" ? "rating" : basis === "all" ? "COALESCE(rating_avg_all, rating)" : "COALESCE(rating_avg, rating)";
      const where = ["tract_id IS NOT NULL", expr + " IS NOT NULL"], binds = [];
      if (cuisine) { where.push("cuisine = ?"); binds.push(cuisine); }
      const { results } = await env.DB.prepare(
        `SELECT tract_id AS region_id, COUNT(*) AS n, AVG(${expr}) AS avg
         FROM establishments WHERE ${where.join(" AND ")} GROUP BY tract_id`
      ).bind(...binds).all();
      const upd = await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first();
      return cachePut(req, ctx, Response.json({ updated: upd?.u ?? null, regions: results || [] }, {
        headers: { "Cache-Control": "public, max-age=86400" },
      }));
    }

    if (url.pathname === "/stats") {
      const v = (await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first())?.u || "0";
      return new Response(STATS_HTML.replace("__DATA_VERSION__", encodeURIComponent(v)),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    // full map payload — served from the KV snapshot (rebuilt each ingest), not a live D1 scan.
    // Client requests ?v=<updated_at>, so edge cache fronts KV; KV fronts D1 (miss-only fallback).
    if (url.pathname === "/api/establishments")
      return serveSnapshot(req, ctx, env, SNAP_EST, buildEstablishments);

    // minimal points for client-side geohash-tile aggregation on /stats — also from the KV snapshot
    if (url.pathname === "/api/points")
      return serveSnapshot(req, ctx, env, SNAP_PTS, buildPoints);

    if (url.pathname === "/api/detail") {
      const id = url.searchParams.get("id");
      const row = await env.DB.prepare(
        "SELECT id,name,report_url,detail FROM establishments WHERE id = ?"
      ).bind(id).first();
      if (!row) return new Response("not found", { status: 404 });
      let detail = {}; try { detail = JSON.parse(row.detail || "{}"); } catch {}
      return Response.json({ id: row.id, name: row.name, report_url: row.report_url, ...detail });
    }

    if (url.pathname === "/api/version") {
      // v = data freshness (1-row index read); b = deployed build id (so the client can auto-reload on a new release)
      const v = (await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first())?.u || "0";
      const b = (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || "0";
      return Response.json({ v, b }, { headers: { "Cache-Control": "no-cache" } });
    }

    if (url.pathname === "/api/stats") {
      const { results } = await env.DB.prepare(
        "SELECT county, rating, COUNT(*) AS n FROM establishments GROUP BY county, rating"
      ).all();
      const upd = await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first();
      return cachePut(req, ctx, Response.json({ updated: upd?.u ?? null, breakdown: results || [] }, { headers: { "Cache-Control": "public, max-age=3600" } }));
    }

    if (url.pathname === "/streetview") {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon || !env.GOOGLE_KEY) return new Response("", { status: 404 });
      const loc = encodeURIComponent(lat + "," + lon);
      const meta = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&source=outdoor&key=${env.GOOGLE_KEY}`)
        .then((r) => r.json()).catch(() => null);
      if (!meta || meta.status !== "OK") return new Response("", { status: 404 });
      const img = await fetch(`https://maps.googleapis.com/maps/api/streetview?size=400x200&location=${loc}&fov=110&source=outdoor&return_error_code=true&key=${env.GOOGLE_KEY}`);
      if (!img.ok) return new Response("", { status: 404 });
      return new Response(img.body, { status: 200, headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
    }
    if (url.pathname === "/sv-embed") {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon || !env.GOOGLE_KEY) return new Response("no imagery", { status: 404 });
      const loc = encodeURIComponent(lat + "," + lon);
      const html = "<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>"
        + `<iframe allowfullscreen referrerpolicy="strict-origin" src="https://www.google.com/maps/embed/v1/streetview?key=${env.GOOGLE_KEY}&location=${loc}&fov=100"></iframe>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/") {
      // inject the data version so the client's establishments fetch is cache-busted on every
      // re-ingest (the API response itself can then be cached hard, keyed by ?v=<updated_at>)
      const v = (await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first())?.u || "0";
      const b = (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || "0";
      const html = MAP_HTML.replace("__DATA_VERSION__", encodeURIComponent(v)).replace("__BUILD__", encodeURIComponent(b));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    return new Response("not found", { status: 404 });
  },
};

const MAP_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sno/King Food Safety — Restaurant Inspection Ratings</title>
<meta name="description" content="Health-inspection ratings for every restaurant in Snohomish &amp; King counties, WA — see any spot's full inspection history and violations on one map.">
<link rel="canonical" href="https://food.snoking.app/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sno/King Food Safety">
<meta property="og:title" content="Sno/King Food Safety — Restaurant Inspection Ratings">
<meta property="og:description" content="Every restaurant in Snohomish + King counties (WA), color-coded by its health-inspection rating. Tap any spot for its full inspection history.">
<meta property="og:url" content="https://food.snoking.app/">
<meta property="og:image" content="https://food.snoking.app/snoking.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Sno/King Food Safety — Restaurant Inspection Ratings">
<meta name="twitter:description" content="Every restaurant in Snohomish + King counties (WA), color-coded by its health-inspection rating.">
<meta name="twitter:image" content="https://food.snoking.app/snoking.jpg">
<meta name="theme-color" content="#0d1117">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png?v=7">
<link rel="icon" type="image/png" href="/icon-192.png?v=7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ratings">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--panel2:#1b212b;--ink:#e6edf3;--muted:#8b949e;--line:#2a3038;
        --r1:#2ecc71;--r2:#a8c800;--r3:#f0a020;--r4:#e5484d;--r0:#7d8590;--accent:#3b82f6}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  #wrap{display:flex;height:100%}
  #feed{width:370px;min-width:370px;height:100%;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line)}
  #map{flex:1;height:100%;background:#e8eaed}
  .em{background:none;border:0}
  .me{background:none;border:0;pointer-events:none}
  #head{padding:calc(13px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 10px calc(16px + env(safe-area-inset-left));cursor:pointer;user-select:none}
  h1{font-size:16px;margin:0;display:flex;align-items:center;gap:8px}
  h1 .statslink{font-size:17px;line-height:1;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center}
  #loc{color:#1d6ef2}
  #loc svg{display:block;transform:translateY(1px)}
  #loc.locating{opacity:.5}
  #about{color:#58a6ff}
  #about svg{display:block}
  h1 .tog{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:#fff;background:var(--accent);padding:6px 12px;border-radius:999px;line-height:1}
  @media(min-width:721px){h1 .tog{display:none}}   /* panel is always open on desktop — no toggle needed */
  h1 .tog b{font-size:16px;line-height:1;transition:transform .15s;display:inline-block}
  #feed:not(.collapsed) h1 .tog b{transform:rotate(180deg)}
  #feed.collapsed #controls,#feed.collapsed #listhead,#feed.collapsed #list,#feed.collapsed #feedfoot{display:none}
  #feedfoot{padding:9px 16px;border-top:1px solid var(--line);font-size:12px;flex:none}
  #feedfoot a{color:var(--muted);text-decoration:none}
  #feedfoot a:hover{text-decoration:underline}
  #feed.collapsed{height:auto;min-height:0}
  .sub{color:var(--muted);font-size:11.5px;margin:3px 0 0}
  #controls{padding:10px 16px 24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--panel2)}
  #q{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:#0d1117;color:var(--ink);font-size:13px}
  .qwrap{position:relative}
  #qclear{display:none;position:absolute;left:6px;top:50%;transform:translateY(-50%);width:20px;height:20px;border:0;border-radius:50%;background:#30363d;color:#c9d1d9;font:14px/18px system-ui;text-align:center;cursor:pointer;padding:0}
  #q.hasclear{padding-left:32px}
  /* iOS auto-zooms on focus when an input's font is <16px; bump it on touch devices to stop that */
  @media (pointer:coarse){#q{font-size:16px}}
  #q::placeholder{color:#6e7681}
  .field{margin-top:11px}
  .field>label{display:block;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
  select{width:100%;padding:8px 9px;border-radius:7px;border:1px solid var(--line);background:#0d1117;color:var(--ink);font-size:12.5px}
  .vals{float:right;color:var(--ink);font-weight:600;text-transform:none;letter-spacing:0}
  .dual{position:relative;height:30px}
  .dual .track{position:absolute;top:13px;left:0;right:0;height:4px;border-radius:3px;background:#30363d}
  .dual .fill{position:absolute;top:13px;height:4px;border-radius:3px;background:var(--accent)}
  .dual input[type=range]{position:absolute;top:0;left:0;width:100%;height:30px;margin:0;background:none;pointer-events:none;-webkit-appearance:none;appearance:none}
  .dual input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid var(--accent);cursor:pointer;margin-top:-6px}
  .dual input[type=range]::-moz-range-thumb{pointer-events:auto;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid var(--accent);cursor:pointer}
  .seg{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
  .seg button{flex:1;padding:7px 4px;border:0;background:#0d1117;color:var(--muted);font:12px system-ui;cursor:pointer}
  .seg button+button{border-left:1px solid var(--line)}
  .seg button.on{background:var(--accent);color:#fff;font-weight:600}
  #legend{position:absolute;left:384px;bottom:18px;z-index:600;background:rgba(22,27,34,.92);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:11px;max-width:200px;backdrop-filter:blur(3px)}
  #legend h4{margin:0 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  #legend .lg{display:flex;align-items:center;gap:7px;line-height:18px}
  #legend .sw{width:11px;height:11px;border-radius:50%;flex:none}
  /* single-row connected segmented control (multi-select) used for discrete/bucketed rating filters */
  .segs{display:flex;margin:6px 0 8px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .seg{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 2px;border-left:1px solid var(--line);background:#0d1117;cursor:pointer;font-size:9.5px;line-height:1.15;text-align:center;color:#c9d2dc;user-select:none;-webkit-tap-highlight-color:transparent}
  .seg:first-child{border-left:0}
  .seg:not(.off){background:#161c24}
  .seg .sw{width:12px;height:12px;border-radius:50%;flex:none}
  .seg.off{opacity:.34}
  .seg.off .sw{filter:grayscale(.55)}
  #listhead{padding:7px 16px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
  #list{flex:1;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none}
  #list::-webkit-scrollbar{display:none}
  .item{padding:8px 16px;border-bottom:1px solid #20262f;cursor:pointer;display:flex;gap:10px;align-items:flex-start}
  .item:hover{background:#1d242e}
  .item .bar{width:4px;align-self:stretch;border-radius:2px;flex:none}
  .item .nm{font-weight:600;font-size:13px}
  .item .ad{color:var(--muted);font-size:11.5px;margin-top:1px}
  .item .mt{color:#6e7681;font-size:11px;margin-top:2px}
  .leaflet-popup-content{font:12.5px system-ui;margin:11px 13px;width:280px!important}
  .pp-name{font-weight:700;font-size:14px;margin-bottom:2px;color:#111}
  .pp-name a{color:#111;text-decoration:none}
  .pp-name a:hover,.pp-name a:focus{color:#0969da;text-decoration:underline}
  .pp-name a:hover .exti,.pp-name a:focus .exti{opacity:1}
  .exti{margin-left:4px;vertical-align:1px;color:#0969da;opacity:.75}
  .pp-badge{display:inline-block;color:#fff;font-weight:600;font-size:11px;padding:2px 8px;border-radius:999px;margin:3px 0;vertical-align:middle}
  .pp-addr{color:#555;font-size:12px}
  .pp-meta{color:#333;font-size:12px;margin-top:4px}
  .pp-meta b{color:#111}
  .sv{width:100%;height:130px;object-fit:cover;border-radius:6px;display:block;margin-bottom:7px;cursor:pointer;background:#eee}
  .pp-sec{margin-top:8px;border-top:1px solid #e3e3e3;padding-top:6px}
  .pp-sec h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#888}
  .ppsec>summary{list-style:none;cursor:pointer;margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#888}
  .ppsec>summary::-webkit-details-marker{display:none}
  .ppsec>summary::before{content:"▾";font-size:9px;margin-right:5px;color:#aaa}
  .ppsec:not([open])>summary::before{content:"▸"}
  .viol{font-size:11.5px;margin-bottom:5px}
  .viol .vh,.viold>summary{font-weight:600;color:#222;font-size:11.5px}
  .viol .vt,.viold .vt{display:inline-block;font-size:9.5px;font-weight:700;color:#fff;padding:1px 5px;border-radius:4px;margin-right:5px;vertical-align:1px}
  .viol .note,.viold .note{color:#555;white-space:pre-wrap;font-size:11px;margin-top:2px;max-height:170px;overflow:auto}
  .viold{margin-bottom:5px}
  .viold>summary{list-style:none;cursor:pointer}
  .viold>summary::-webkit-details-marker{display:none}
  .viold>summary::before{content:"▸ ";color:#aaa;font-weight:400;font-size:9px}
  .viold[open]>summary::before{content:"▾ "}
  .hist{font-size:11px;color:#444;display:flex;justify-content:space-between;border-top:1px dotted #ddd;padding:2px 0}
  .hsub{font-weight:400;color:#999;font-size:10px}
  .histd{font-size:11px}
  .histd>summary{list-style:none;cursor:pointer;color:#444;display:flex;justify-content:space-between;align-items:center;border-top:1px dotted #ddd;padding:3px 0}
  .histd>summary::-webkit-details-marker{display:none}
  .histd>summary .hr::after{content:"▸";color:#aaa;font-size:9px;margin-left:6px}
  .histd[open]>summary .hr::after{content:"▾"}
  .histd[open]>summary{font-weight:600;color:#111}
  .histv{padding:3px 0 6px 0}
  .pp-link{display:inline-block;margin-top:7px;font-size:11.5px;color:#0969da;text-decoration:none;font-weight:600}
  .loading{color:#999;font-size:11.5px}
  /* OSM credit — required on the map itself. Tinted to match the dark chrome instead of Leaflet's white. */
  .leaflet-control-attribution{background:rgba(13,17,23,.74);color:#8b949e;font-size:10.5px;line-height:1.5;padding:1px 7px;border-radius:5px 0 0 0;box-shadow:none}
  .leaflet-control-attribution a{color:#9fb6d0;text-decoration:none}
  .leaflet-control-attribution a:hover,.leaflet-control-attribution a:focus{color:#c9d9ea;text-decoration:underline}
  @media (max-width:720px){
    #wrap{display:block;position:relative}
    #map{position:absolute;inset:0;height:100%;width:100%}
    /* filter panel becomes a scrollable overlay over a full-screen map, so all
       controls are reachable (no fixed-height clipping) */
    #feed{position:absolute;top:0;left:0;right:0;z-index:1000;width:auto;min-width:0;max-height:100dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-right:0;border-bottom:1px solid var(--line);box-shadow:0 10px 28px rgba(0,0,0,.45)}
    #feed.collapsed{max-height:none;overflow:visible;box-shadow:none}
    #list{flex:none}
    /* sit the legend above the attribution strip so neither covers the other */
    #legend{left:14px;bottom:26px;z-index:500}
  }
  /* while a restaurant card is open, hide the legend so it doesn't cover it */
  body.popup-open #legend{display:none}
</style></head><body>
<div id="wrap">
  <div id="feed">
    <div id="head">
      <h1>Sno/King Food Safety <a class="statslink" id="lnk-stats" href="/stats" title="Ratings by area" aria-label="Stats">📊</a> <a class="statslink" id="lnk-bloop" href="/bloopers" title="Inspection bloopers" aria-label="Bloopers">😅</a> <span class="statslink" id="bell" role="button" title="Get notified when a favorite's rating changes" aria-label="Alerts" style="font-size:14px">🔔</span> <a class="statslink" id="about" href="/about" title="About &amp; methodology" aria-label="About"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.15" fill="currentColor" stroke="none"/></svg></a> <span class="statslink" id="loc" role="button" title="Zoom to my location" aria-label="My location"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M21 3 3 10.53l7.61 2.86L13.47 21 21 3z"/></svg></span> <span class="tog" id="tog" title="Show/hide filters">Filters <b>▾</b></span></h1>
    </div>
    <div id="controls">
      <div class="qwrap"><button type="button" id="qclear" aria-label="Clear search" title="Clear">×</button><input id="q" placeholder="Search name or address…" autocomplete="off"></div>
      <div class="field">
        <label>Cuisine</label>
        <select id="cuisine"><option value="">All cuisines</option></select>
      </div>
      <div class="field">
        <label>Shade by <span class="vals" id="emojihint" style="font-weight:400;color:var(--muted)"></span></label>
        <select id="colorby">
          <option value="rating">Rating (latest)</option>
          <option value="resid">vs cuisine norm (over/under-performers)</option>
          <option value="routine">Last routine (ignores reinspections)</option>
          <option value="avg">Avg of last 5 inspections</option>
          <option value="worstpts">Worst inspection (points)</option>
          <option value="poorfrac">% routines Okay-or-worse (chronic)</option>
          <option value="changed">Recently changed (new + up/down)</option>
          <option value="age">Years in operation</option>
          <option value="cuisine">Cuisine</option>
        </select>
      </div>
      <div class="field" id="rfield">
        <label><span id="rlabel">Rating</span> <span class="vals" id="rval"></span></label>
        <div class="dual" id="rslider"></div>
      </div>
    </div>
    <div id="listhead"><span id="count">…</span><span><span id="upd"></span> · <span id="sortdir" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px" title="Click to change sort">A–Z</span></span></div>
    <div id="list"></div>
    <div id="feedfoot"><a href="/browse">Browse all restaurants by city →</a></div>
  </div>
  <div id="map"></div>
  <div id="legend"></div>
</div>
<script>
var DATA_VERSION="__DATA_VERSION__", BUILD_VERSION="__BUILD__";
var COLOR={1:"#2ecc71",2:"#a8c800",3:"#f0a020",4:"#e5484d",0:"#7d8590"};
var LABEL={1:"Excellent",2:"Good",3:"Okay",4:"Needs to Improve",0:"Unrated"};
var RLABELS=["","Excellent","Good","Okay","Needs Improve"];
var COUNTY={k:"King County",s:"Snohomish County"};
var CU_LABEL={pizza:"Pizza",mexican:"Mexican",chinese:"Chinese",japanese:"Japanese / Sushi",teriyaki:"Teriyaki",thai:"Thai",vietnamese:"Vietnamese",korean:"Korean",indian:"Indian",mediterranean:"Mediterranean",italian:"Italian",bbq:"BBQ",burgers:"Burgers",chicken:"Chicken",sandwich:"Sandwich / Deli",seafood:"Seafood",coffee:"Coffee / Tea",bakery:"Bakery / Dessert",bar:"Bar / Pub",grocery:"Grocery / Market",fastfood:"Fast Food",cafe_diner:"Cafe / Diner",school:"School / Education",seniorcare:"Senior / Care",hotel:"Hotel / Lodging",catering:"Catering",foodtruck:"Food Truck / Mobile",venue:"Venue / Workplace",workplace:"Workplace / Cafeteria",other:"Other"};
var NOW_Y=new Date().getFullYear();
// Cuisines ordered by similarity, then spread evenly around the HSL hue wheel so
// neighbouring hues are related cuisines: American comfort (red→yellow) → European
// (yellow-green) → S/SE/E-Asian (green→blue) → seafood → sweets & drinks (purple→
// magenta). Grocery/Other are neutral greys, off the wheel.
var CU_ORDER=["mexican","bbq","burgers","fastfood","chicken","sandwich","pizza","italian","mediterranean","indian","thai","vietnamese","chinese","japanese","teriyaki","korean","seafood","coffee","bakery","cafe_diner","bar"];
var CU_COLOR={};CU_ORDER.forEach(function(k,i){CU_COLOR[k]="hsl("+Math.round(i*360/CU_ORDER.length)+",68%,55%)";});
// non-restaurant venue/service types: muted earth tones, distinct from the vivid cuisine hues
CU_COLOR.grocery="#8a8f98";CU_COLOR.school="#5b8aa6";CU_COLOR.venue="#8c6fb0";CU_COLOR.hotel="#b5895a";CU_COLOR.catering="#7fa05a";CU_COLOR.foodtruck="#cf7a4d";CU_COLOR.seniorcare="#6f9a8d";CU_COLOR.other="#5b626b";
// collapse fine cuisines into broader groups for the SHADE-by-cuisine colors + legend (the
// dropdown filter stays fine-grained). Add to CU_GROUP to keep collapsing.
var CU_GROUP={chinese:"asian",japanese:"asian",thai:"asian",vietnamese:"asian",korean:"asian",
  hotel:"industry",catering:"industry",school:"industry",seniorcare:"industry",venue:"industry",foodtruck:"industry",workplace:"industry",
  coffee:"cafe",bakery:"cafe",cafe_diner:"cafe",
  bbq:"grill",burgers:"grill",chicken:"grill",american:"grill"};
function cuGroup(c){return CU_GROUP[c]||c;}
// shade-by-cuisine GROUP palette: the visible food groups are ordered by flavor-family
// similarity and spread along the hue wheel so ADJACENT groups get adjacent colors —
// warm American/Latin (red→orange) → European (yellow→yellow-green) → Mediterranean/
// African (green) → South/East-Asian (teal→cyan) → seafood (blue) → sweets & drinks
// (purple→magenta). Industry/grocery/other stay muted & off-wheel so they never read as
// a cuisine. This overrides any earlier hue-wheel values for these keys.
var CU_GHUE={grill:8,fastfood:28,mexican:46,sandwich:62,pizza:78,italian:94,mediterranean:114,african:136,indian:158,asian:178,teriyaki:197,seafood:217,cafe:272,bar:315};
Object.keys(CU_GHUE).forEach(function(k){CU_COLOR[k]="hsl("+CU_GHUE[k]+",62%,53%)";});
CU_COLOR.industry="#7b8a9a";
CU_LABEL.asian="Asian";CU_LABEL.industry="Industry / Institutional";CU_LABEL.cafe="Cafe / Coffee / Sweets";CU_LABEL.grill="American / Grill";CU_LABEL.american="American";CU_LABEL.african="Ethiopian / African";CU_LABEL.workplace="Workplace / Cafeteria";
var GROUP_ORDER=["grill","fastfood","mexican","sandwich","pizza","italian","mediterranean","african","indian","asian","teriyaki","seafood","cafe","bar","grocery","industry","other"];
// one emoji per category — drawn on a rating-colored disc so cuisine + rating read at once
var CU_EMOJI={pizza:"🍕",mexican:"🌮",chinese:"🥡",japanese:"🍣",teriyaki:"🍱",thai:"🍜",vietnamese:"🍲",korean:"🥘",indian:"🍛",mediterranean:"🥙",italian:"🍝",bbq:"🍖",burgers:"🍔",chicken:"🍗",sandwich:"🥪",seafood:"🦐",coffee:"☕",bakery:"🧁",bar:"🍺",grocery:"🛒",fastfood:"🍟",cafe_diner:"🥞",school:"🏫",seniorcare:"🏥",hotel:"🏨",catering:"🍽️",foodtruck:"🚚",venue:"🏟️",workplace:"🏢",asian:"🥢",american:"🥩",african:"🫓",other:"🍴"};
var AGE_PAL=["#cfe8f3","#92c5de","#4393c3","#2166ac","#0b3d73"], AGE_BK=[2,5,10,15], AGE_LBL=["≤2 yr","3–5 yr","6–10 yr","11–15 yr","16+ yr"];
var colorMode="rating", sortMode="alpha";   // list sort cycles "alpha" (A–Z) -> "best" -> "worst" -> "alpha"
function esc(s){return (s==null?"":String(s)).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
function ratingOf(d){return d.r==null?0:d.r;}
function ageOf(d){if(!d.fd)return null;var y=+String(d.fd).slice(0,4);return isFinite(y)?Math.max(0,NOW_Y-y):null;}
function ageColor(d){var a=ageOf(d);if(a==null)return"#555";for(var i=0;i<AGE_BK.length;i++)if(a<=AGE_BK[i])return AGE_PAL[i];return AGE_PAL[4];}
var AVG_STOPS={1:[46,204,113],2:[168,200,0],3:[240,160,32],4:[229,72,77]};   // green→red anchors for 1..4
function avgColor(d){var v=d.ra;if(v==null)return"#555";v=Math.max(1,Math.min(4,v));var i=Math.floor(v);if(i>=4)return"rgb(229,72,77)";var a=AVG_STOPS[i],b=AVG_STOPS[i+1],t=v-i;return"rgb("+Math.round(a[0]+(b[0]-a[0])*t)+","+Math.round(a[1]+(b[1]-a[1])*t)+","+Math.round(a[2]+(b[2]-a[2])*t)+")";}
var PF_STOPS=[[0,[46,204,113]],[0.34,[168,200,0]],[0.67,[240,160,32]],[1,[229,72,77]]];   // 0→green … 1→red
function pfColor(d){var v=d.pf;if(v==null)return"#555";v=Math.max(0,Math.min(1,v));
  for(var i=0;i<PF_STOPS.length-1;i++){var a=PF_STOPS[i],b=PF_STOPS[i+1];if(v<=b[0]){var t=(v-a[0])/((b[0]-a[0])||1);
    return"rgb("+Math.round(a[1][0]+(b[1][0]-a[1][0])*t)+","+Math.round(a[1][1]+(b[1][1]-a[1][1])*t)+","+Math.round(a[1][2]+(b[1][2]-a[1][2])*t)+")";}}
  return"rgb(229,72,77)";}
// worst single-inspection POINTS — continuous, wide range (0 → green … 150+ → near-black red)
var WP_STOPS=[[0,[46,204,113]],[15,[168,200,0]],[40,[240,160,32]],[80,[229,72,77]],[150,[110,0,0]]];
function wpColor(d){var v=d.wp;if(v==null)return"#555";v=Math.max(0,v);
  for(var i=0;i<WP_STOPS.length-1;i++){var a=WP_STOPS[i],b=WP_STOPS[i+1];if(v<=b[0]){var t=(v-a[0])/((b[0]-a[0])||1);
    return"rgb("+Math.round(a[1][0]+(b[1][0]-a[1][0])*t)+","+Math.round(a[1][1]+(b[1][1]-a[1][1])*t)+","+Math.round(a[1][2]+(b[1][2]-a[1][2])*t)+")";}}
  return"rgb(110,0,0)";}
// ── residual vs cuisine norm ────────────────────────────────────────────────
// CUMEAN[cu] = mean avg-5 rating for that fine cuisine (computed at load). residual =
// cuisine mean − this place's own rating, so POSITIVE = better than its cuisine's peers
// (controls for the fact that e.g. Chinese is graded harder than coffee). Diverging
// green(better)↔red(worse) scale centered on 0.
var CUMEAN={};
function residOf(d){var mu=CUMEAN[d.cu];if(mu==null)return null;var base=d.ra!=null?d.ra:(d.r==null?null:d.r);return base==null?null:(mu-base);}
var RD_STOPS=[[-1.3,[214,40,40]],[-0.5,[242,153,42]],[0,[150,156,164]],[0.5,[166,204,66]],[1.3,[30,150,76]]];   // distinct HUE per level: much worse=red, worse=orange, typical=gray, better=lime, much better=deep green
function residColorAt(v){if(v==null)return"#555";v=Math.max(-1.3,Math.min(1.3,v));
  for(var i=0;i<RD_STOPS.length-1;i++){var a=RD_STOPS[i],b=RD_STOPS[i+1];if(v<=b[0]){var t=(v-a[0])/((b[0]-a[0])||1);
    return"rgb("+Math.round(a[1][0]+(b[1][0]-a[1][0])*t)+","+Math.round(a[1][1]+(b[1][1]-a[1][1])*t)+","+Math.round(a[1][2]+(b[1][2]-a[1][2])*t)+")";}}
  return"rgb(31,150,79)";}
function residColor(d){return residColorAt(residOf(d));}
// ── recent rating changes ───────────────────────────────────────────────────
// cd = rating_changed_at (date the current rating took effect), pr = prev_rating (the rating
// before that change, null if this is a first/new rating). Tracked server-side at ingest, so it
// only fills in as ratings actually move from here forward.
function daysSince(s){if(!s)return null;var t=Date.parse(s);if(isNaN(t))return null;return Math.floor((Date.now()-t)/86400000);}
function changeKind(d){if(d.cd==null)return null;if(d.pr==null)return"new";if(d.r==null)return null;if(d.r<d.pr)return"up";if(d.r>d.pr)return"down";return"same";}
function changeColor(d){var k=changeKind(d);if(k==="up")return"#2ecc71";if(k==="down")return"#e5484d";if(k==="new")return COLOR[ratingOf(d)];return"#7d8590";}
function changeGlyph(d){var k=changeKind(d);return k==="up"?"↑":k==="down"?"↓":(CU_EMOJI[d.cu]||"🍴");}
function agoTxt(s){var n=daysSince(s);return n==null?"":n<=0?"today":n===1?"yesterday":n+"d ago";}
function svcLabel(cs){return cs==="routine"?"routine":cs==="reinspection"?"reinspection":cs==="grade"?"grade update":"";}
function changeText(d){var k=changeKind(d),sv=svcLabel(d.cs),w=agoTxt(d.cd),tail=(sv?" · "+sv:"")+(w?" · "+w:"");if(k==="new")return"New · "+LABEL[ratingOf(d)]+tail;if(k==="up")return LABEL[d.pr]+" → "+LABEL[d.r]+" ↑"+tail;if(k==="down")return LABEL[d.pr]+" → "+LABEL[d.r]+" ↓"+tail;return"changed"+tail;}
function colorOf(d){if(colorMode==="cuisine")return CU_COLOR[cuGroup(d.cu)]||"#555";if(colorMode==="age")return ageColor(d);if(colorMode==="avg")return avgColor(d);
  if(colorMode==="changed")return changeColor(d);
  if(colorMode==="routine")return COLOR[d.rr==null?0:d.rr];if(colorMode==="worstpts")return wpColor(d);if(colorMode==="poorfrac")return pfColor(d);if(colorMode==="resid")return residColor(d);return COLOR[ratingOf(d)];}
function renderLegend(){
  var el=document.getElementById("legend"),h="";
  if(colorMode==="rating"||colorMode==="routine"){h='<h4>'+(colorMode==="routine"?"Last routine rating":"Rating")+'</h4>';[1,2,3,4,0].forEach(function(r){h+='<div class="lg"><span class="sw" style="background:'+COLOR[r]+'"></span>'+LABEL[r]+'</div>';});}
  else if(colorMode==="worstpts"){h='<h4>Worst inspection (points)</h4>';[[0,"0 — clean"],[15,"15"],[40,"40"],[80,"80"],[150,"150+ — extreme"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+wpColor({wp:p[0]})+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no inspections</div>';}
  else if(colorMode==="avg"){h='<h4>Avg of last 5 inspections</h4>';[[1,"Excellent"],[2,"Good"],[3,"Okay"],[4,"Needs improve"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+avgColor({ra:p[0]})+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no history</div>';}
  else if(colorMode==="poorfrac"){h='<h4>% routines Okay-or-worse</h4>';[[0,"0% — always clean"],[0.34,"~⅓ of routines"],[0.67,"~⅔ of routines"],[1,"100% — always poor"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+pfColor({pf:p[0]})+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no routine inspections</div>';}
  else if(colorMode==="age"){h='<h4>Years on record</h4>';AGE_PAL.forEach(function(c,i){h+='<div class="lg"><span class="sw" style="background:'+c+'"></span>'+AGE_LBL[i]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>unknown</div>';}
  else if(colorMode==="resid"){h='<h4>vs cuisine norm</h4>';[[1.3,"much better than peers"],[0.5,"better"],[0,"typical for its cuisine"],[-0.5,"worse"],[-1.3,"much worse than peers"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+residColorAt(p[0])+'"></span>'+p[1]+'</div>';});}
  else if(colorMode==="changed"){h='<h4>Recently changed</h4>';
    h+='<div class="lg"><span class="sw" style="background:#2ecc71"></span>improved ↑</div>';
    h+='<div class="lg"><span class="sw" style="background:#e5484d"></span>declined ↓</div>';
    h+='<div class="lg" style="margin-top:5px;font-size:10px;color:var(--muted)">new rating (by grade):</div>';
    [1,2,3,4].forEach(function(r){h+='<div class="lg"><span class="sw" style="background:'+COLOR[r]+'"></span>'+LABEL[r]+'</div>';});}
  else{h='<h4>Cuisine</h4>';var seen={};ALL.forEach(function(d){seen[cuGroup(d.cu)]=1;});GROUP_ORDER.filter(function(g){return seen[g]&&(fCuisine||(g!=="grocery"&&g!=="industry"&&g!=="other"));}).forEach(function(g){h+='<div class="lg"><span class="sw" style="background:'+(CU_COLOR[g]||"#555")+'"></span>'+(CU_LABEL[g]||g)+'</div>';});}
  el.innerHTML=h;
}
function recolor(){render();renderLegend();}   // drawMarkers re-styles dots / rebuilds emoji icons
function fmtDate(s){if(!s)return"";var d=new Date(s);return isNaN(d)?s:d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});}

// start collapsed on small screens so the map gets the whole viewport (tap "Filters" to open)
if(window.matchMedia("(max-width:720px)").matches) document.getElementById("feed").classList.add("collapsed");
// no +/- buttons (scroll wheel / pinch / double-tap / keyboard +- still zoom). OSM's attribution
// guidelines require the credit on the map itself, so the attribution control stays on.
var map=L.map("map",{preferCanvas:true,zoomControl:false}).setView([47.7,-122.1],10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'}).addTo(map);
map.attributionControl.setPrefix("");   // drop the "Leaflet" flag — not required, and space is tight on phones
var canvas=L.canvas({padding:.5});
// enlarge the hit target for the small canvas dots so a near-miss still registers. On TOUCH we pad
// generously (fat fingers); with a MOUSE we keep it tight, because a fat pad makes a neighbouring
// dot's hit region overlap the one you're aiming at (in dense clusters the wrong dot would fire).
var DOTPAD=window.matchMedia&&window.matchMedia("(pointer: coarse)").matches?11:2;
L.CircleMarker.prototype._clickTolerance=function(){return (this.options.stroke?this.options.weight/2:0)+DOTPAD;};
var layer=L.layerGroup().addTo(map);
var emojiLayer=L.layerGroup(), emojiMode=true, EMOJI_ZOOM=15, lastVis=[], popupOpen=false;

var ALL=[], LOC=[], MARK=[], maxAge=20, WPMAX=150;   // LOC = establishments clustered by ~proximity
var fCuisine="", coOn={k:1,s:1}, query="", queryToks=[];
// search is token-based (all tokens must match anywhere) so a pasted full address like
// "18437 E Valley Hwy, Kent, WA 98032" works — commas/state/zip don't need to be contiguous
function setQuery(v){query=(v||"").toLowerCase().trim();queryToks=query?query.split(/[^a-z0-9]+/).filter(Boolean):[];}
// the rating-style range filter follows the "shade by" dropdown: METRIC is the active metric
// config (value accessor + min/max/step/label/format), fRange is its current [lo,hi]. Cuisine
// mode has no numeric metric (METRIC=null) so the slider is hidden. MET is built after load
// because worstpts/age maxima come from the data.
var MET={}, METRIC=null, fRange=[1,4], chipSel=[], curVisEst=[];   // chipSel = selected bucket indices for chip metrics
// each metric: val=accessor, fmt=range label for the slider, disp=single-value label for the list row
function buildMetrics(){
  // "chip" metrics expose a buckets[] (label/color/match) -> a segmented multi-select instead of a slider.
  // exact=true matches a discrete rating value; otherwise the continuous value is rounded into a 1–4 bucket.
  // ordered worst→best so the best band (Excellent / Much better) sits on the RIGHT of the segmented control
  function rbk(cf,exact){return [4,3,2,1].map(function(r){return {label:RLABELS[r],color:cf(r),
    match:exact?function(v){return v===r;}:function(v){return Math.max(1,Math.min(4,Math.round(v)))===r;}};});}
  var RESID_BK=[   // same 5 bands the legend shows, worst→best (best on the right)
    {label:"Much worse",color:residColorAt(-1.3),match:function(v){return v<=-0.9;}},
    {label:"Worse",color:residColorAt(-0.5),match:function(v){return v>-0.9&&v<=-0.25;}},
    {label:"Typical",color:residColorAt(0),match:function(v){return v>-0.25&&v<0.25;}},
    {label:"Better",color:residColorAt(0.5),match:function(v){return v>=0.25&&v<0.9;}},
    {label:"Much better",color:residColorAt(1.3),match:function(v){return v>=0.9;}}];
  MET={
  rating:{label:"Rating",min:1,max:4,step:1,val:function(d){return d.r;},fmt:function(a,b){return a===b?RLABELS[a]:RLABELS[a]+" – "+RLABELS[b];},disp:function(d){return LABEL[ratingOf(d)];},buckets:rbk(function(r){return COLOR[r];},true)},
  avg:{label:"Avg of last 5",min:1,max:4,step:0.1,val:function(d){return d.ra;},fmt:function(a,b){return a.toFixed(1)+" – "+b.toFixed(1);},disp:function(d){return d.ra==null?"no history":LABEL[Math.max(1,Math.min(4,Math.round(d.ra)))]+" ("+d.ra.toFixed(1)+")";},buckets:rbk(function(r){return avgColor({ra:r});},false)},
  routine:{label:"Last routine rating",min:1,max:4,step:1,val:function(d){return d.rr;},fmt:function(a,b){return a===b?RLABELS[a]:RLABELS[a]+" – "+RLABELS[b];},disp:function(d){return d.rr==null?"no routine":LABEL[d.rr]+" (routine)";},buckets:rbk(function(r){return COLOR[r];},true)},
  worstpts:{label:"Worst inspection (pts)",min:0,max:WPMAX,step:5,val:function(d){return d.wp;},fmt:function(a,b){return a+" – "+(b>=WPMAX?b+"+":b)+" pts";},disp:function(d){return d.wp==null?"no inspections":d.wp+" pts worst";}},
  poorfrac:{label:"% routines Okay-or-worse",min:0,max:100,step:5,val:function(d){return d.pf==null?null:Math.round(d.pf*100);},fmt:function(a,b){return a+"% – "+b+"%";},disp:function(d){return d.pf==null?"no routine":Math.round(d.pf*100)+"% poor routines";}},
  age:{label:"Years in operation",min:0,max:maxAge,step:1,val:function(d){return ageOf(d);},fmt:function(a,b){return a+(b>=maxAge?" – "+b+"+":" – "+b)+" yr";},disp:function(d){var a=ageOf(d);return a==null?"age unknown":a+"y on record";}},
  // residual is signed: POSITIVE = better than the cuisine's mean. hiWorse:false flips the list sort.
  resid:{label:"vs cuisine norm",min:-1.3,max:1.3,step:0.1,hiWorse:false,val:function(d){return residOf(d);},
    fmt:function(a,b){return a.toFixed(1)+" … "+b.toFixed(1)+" vs peers";},
    disp:function(d){var v=residOf(d);return v==null?"no rating":(v>=0?"+":"")+v.toFixed(2)+" vs "+(CU_LABEL[d.cu]||"cuisine")+" norm";},buckets:RESID_BK},
  // recency of the last rating change; hiWorse:false sorts the most-recent change to the top.
  // def opens the slider to the last 30 days; widen toward 90 to see more history.
  changed:{label:"Changed in last (days)",min:0,max:90,step:1,hiWorse:false,def:[0,30],val:function(d){return daysSince(d.cd);},
    fmt:function(a,b){return a+"–"+(b>=90?"90+":b)+" days ago";},
    disp:function(d){return changeText(d);}}
};}
// switch the range filter to the metric matching the current shade-by mode; rebuilds the slider
// and resets the range to fully-open. Caller re-renders.
function applyMetric(mode){
  METRIC=MET[mode]||null;
  var field=document.getElementById("rfield");
  if(!METRIC){field.style.display="none";return;}
  field.style.display="";
  document.getElementById("rlabel").textContent=METRIC.label;
  if(METRIC.buckets){chipSel=METRIC.buckets.map(function(_,i){return i;});renderSegs();return;}   // chip metric: all buckets on
  document.getElementById("rval").textContent="";
  fRange=METRIC.def?METRIC.def.slice():[METRIC.min,METRIC.max];
  dualSlider(document.getElementById("rslider"),METRIC.min,METRIC.max,fRange.slice(),
    function(v){fRange=v;render();},
    function(a,b){document.getElementById("rval").textContent=METRIC.fmt(a,b);},METRIC.step);
}
// segmented multi-select for bucketed metrics: one tap toggles a band in/out (min one stays on)
function renderSegs(){
  var el=document.getElementById("rslider"),bk=METRIC.buckets;
  document.getElementById("rval").textContent="";
  var h='<div class="segs">';
  bk.forEach(function(b,i){h+='<span class="seg'+(chipSel.indexOf(i)>=0?'':' off')+'" data-i="'+i+'"><span class="sw" style="background:'+b.color+'"></span>'+b.label+'</span>';});
  el.innerHTML=h+'</div>';
  el.querySelectorAll(".seg").forEach(function(s){s.onclick=function(){
    var i=+s.dataset.i,at=chipSel.indexOf(i);
    if(at>=0){if(chipSel.length>1){chipSel.splice(at,1);}}else{chipSel.push(i);}   // keep at least one selected
    renderSegs();render();};});
}
function bucketOf(v){var bk=METRIC.buckets;for(var i=0;i<bk.length;i++)if(bk[i].match(v))return i;return -1;}
// persist the full map state (center/zoom + every filter) so leaving for /about or /stats and
// clicking "back to map" returns you exactly where you were. sessionStorage = tab-scoped, auto-cleared.
function saveView(){try{sessionStorage.setItem("snoking_view",JSON.stringify({
  la:map.getCenter().lat,lo:map.getCenter().lng,z:map.getZoom(),
  cu:document.getElementById("cuisine").value,cm:colorMode,sm:sortMode,fr:fRange,ch:chipSel,q:query,t:Date.now()}));}catch(e){}}
function restoreView(rv){
  // shade-by first (applyMetric rebuilds the range slider + resets fRange to the metric default)
  if(rv.cm){var cb=document.getElementById("colorby");if(cb)cb.value=rv.cm;colorMode=rv.cm;}
  applyMetric(colorMode);
  // re-apply the saved filter over the freshly-rebuilt control (slider range, or chip selection)
  if(METRIC&&METRIC.buckets){if(rv.ch&&rv.ch.length){chipSel=rv.ch.slice();renderSegs();}}
  else if(rv.fr&&METRIC){fRange=rv.fr.slice();
    dualSlider(document.getElementById("rslider"),METRIC.min,METRIC.max,fRange.slice(),
      function(v){fRange=v;render();},
      function(a,b){document.getElementById("rval").textContent=METRIC.fmt(a,b);},METRIC.step);}
  if(rv.cu!=null){var sel=document.getElementById("cuisine");sel.value=rv.cu;
    if(rv.cu==="__fav"){favOnly=true;fCuisine="";}else{favOnly=false;fCuisine=rv.cu;}}
  if(rv.sm)sortMode=rv.sm;
  if(rv.q){setQuery(rv.q);var qi=document.getElementById("q");if(qi)qi.value=rv.q;}
  updateSortLabel();
  if(rv.la!=null&&rv.lo!=null&&rv.z!=null)map.setView([rv.la,rv.lo],rv.z);
  recolor();
}
// the cluster is represented by its WORST member ON THE ACTIVE shade metric, so the bubble's
// color + emoji always match the worst item shown in the list popup. "Worseness" normalizes so
// higher = worse (hiWorse:false metrics like the cuisine residual invert); no-data members score
// -Infinity so a rated place always wins. Falls back to latest rating when no metric is active
// (shade-by-cuisine), preserving the old worst-rated pick there.
function reprWorseness(d){if(!METRIC)return ratingOf(d);var v=METRIC.val(d);if(v==null)return -Infinity;return (METRIC.hiWorse===false?-1:1)*v;}
function reprOf(vm){var w=vm[0],wv=reprWorseness(w);for(var i=1;i<vm.length;i++){var v=reprWorseness(vm[i]);if(v>wv){wv=v;w=vm[i];}}return w;}
// cluster establishments within thM metres into one location (sets d._loc). Sub-metre geocoding
// differences round to different exact keys but still overlap at any zoom, so group by distance,
// not an exact coordinate string. Grid-bucketed (cell≈thM) so it's ~O(n) for 15k points.
function clusterLocations(items,thM){
  var dLat=thM/111111, RC=Math.cos(47.6*Math.PI/180), dLon=thM/(111111*RC), cells={}, locs=[];
  function dist(a,b){var x=(b.la-a.la)*111111,y=(b.lo-a.lo)*111111*Math.cos(a.la*Math.PI/180);return Math.sqrt(x*x+y*y);}
  for(var i=0;i<items.length;i++){var d=items[i],ci=Math.floor(d.la/dLat),cj=Math.floor(d.lo/dLon),found=null;
    for(var a=-1;a<=1&&!found;a++)for(var b=-1;b<=1&&!found;b++){var arr=cells[(ci+a)+":"+(cj+b)];
      if(arr)for(var k=0;k<arr.length;k++){if(dist(d,arr[k])<=thM){found=arr[k];break;}}}
    if(found){found.m.push(d);d._loc=found;}
    else{var loc={la:d.la,lo:d.lo,m:[d],_vm:[d]};d._loc=loc;locs.push(loc);(cells[ci+":"+cj]||(cells[ci+":"+cj]=[])).push(loc);}}
  return locs;
}

// ── dual-range slider ─────────────────────────────────────────────────────────
function dualSlider(el,min,max,init,onChange,fmt,step){
  var lo=init[0],hi=init[1];step=step||1;
  el.innerHTML='<div class="track"></div><div class="fill"></div>'+
    '<input type="range" class="lo" min="'+min+'" max="'+max+'" step="'+step+'" value="'+lo+'">'+
    '<input type="range" class="hi" min="'+min+'" max="'+max+'" step="'+step+'" value="'+hi+'">';
  var iLo=el.querySelector(".lo"),iHi=el.querySelector(".hi"),fill=el.querySelector(".fill");
  function paint(){var a=(lo-min)/(max-min)*100,b=(hi-min)/(max-min)*100;fill.style.left=a+"%";fill.style.width=(b-a)+"%";fmt(lo,hi);}
  function upd(){lo=Math.min(+iLo.value,+iHi.value);hi=Math.max(+iLo.value,+iHi.value);if(+iLo.value>+iHi.value){var t=iLo.value;iLo.value=iHi.value;iHi.value=t;}paint();onChange([lo,hi]);}
  iLo.oninput=upd;iHi.oninput=upd;paint();
  return {set:function(a,b){lo=a;hi=b;iLo.value=a;iHi.value=b;paint();}};
}

// ── filtering ─────────────────────────────────────────────────────────────────
function passes(d){
  if(favOnly && !isFav(d.id)) return false;
  if(fCuisine && d.cu!==fCuisine) return false;
  if(colorMode==="cuisine"&&!fCuisine){var g=cuGroup(d.cu);if(g==="grocery"||g==="industry"||g==="other")return false;}   // hide non-cuisine groups in cuisine view
  if(colorMode==="worstpts"&&d.wp==null) return false;     // no inspections — hide from worst-points view
  if(colorMode==="poorfrac"&&d.pf==null) return false;     // no routine inspections — hide from chronic view
  if(colorMode==="changed"&&d.cd==null) return false;      // no tracked rating change — hide from recent-changes view
  if(METRIC){                                              // value filter follows the shade-by metric
    var v=METRIC.val(d);
    if(METRIC.buckets){                                    // segmented chips: pass if v's band is selected
      if(v==null){ if(chipSel.length<METRIC.buckets.length) return false; }   // no value: only when all bands on
      else{var bi=bucketOf(v); if(bi<0||chipSel.indexOf(bi)<0) return false;}
    }else{
      var full=(fRange[0]<=METRIC.min&&fRange[1]>=METRIC.max);
      if(v==null){ if(!full) return false; }               // no value for this metric: only when fully open
      else if(v<fRange[0]||v>fRange[1]) return false;
    }
  }
  if(queryToks.length){var h=(d.n+" "+(d.a||"")+" "+(d.ci||"")+" "+(d.z||"")+" wa").toLowerCase();
    for(var qk=0;qk<queryToks.length;qk++)if(h.indexOf(queryToks[qk])<0)return false;}
  return true;
}
function render(){
  var visEst=[],idx=[],shown=0;
  for(var i=0;i<LOC.length;i++){var vm=LOC[i].m.filter(passes);LOC[i]._vm=vm;
    if(vm.length){idx.push(i);shown+=vm.length;for(var j=0;j<vm.length;j++)visEst.push(vm[j]);}}
  lastVis=idx;
  curVisEst=visEst;
  drawMarkers(idx);
  renderList();
}
// dots (fast canvas, all visible) OR emoji (viewport-culled, only when zoomed in). One marker
// per LOCATION; coincident establishments share it (count badge + list popup).
function drawMarkers(idx){
  var useEmoji=emojiMode&&map.getZoom()>=EMOJI_ZOOM;
  updateEmojiHint();
  if(useEmoji){
    layer.clearLayers();
    if(!map.hasLayer(emojiLayer))emojiLayer.addTo(map);
    emojiLayer.clearLayers();
    var b=map.getBounds().pad(0.15),CAP=1500,n=0;
    for(var k=0;k<idx.length&&n<CAP;k++){var loc=LOC[idx[k]];
      if(!b.contains([loc.la,loc.lo]))continue;
      emojiLayer.addLayer(emojiMarker(loc));n++;}
  }else{
    if(map.hasLayer(emojiLayer))emojiLayer.clearLayers();
    layer.clearLayers();
    for(var k=0;k<idx.length;k++){var loc=LOC[idx[k]],mk=MARK[idx[k]],vm=loc._vm;
      mk.setStyle({fillColor:colorOf(reprOf(vm))});   // uniform size; grouping shown via the list popup
      layer.addLayer(mk);}
  }
}
function emojiIcon(loc){var vm=loc._vm,rp=reprOf(vm),col=colorOf(rp),em=colorMode==="changed"?changeGlyph(rp):(CU_EMOJI[rp.cu]||"🍴"),n=vm.length;
  var badge=n>1?'<div style="position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#111;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;box-shadow:0 0 0 1.5px #fff">'+n+'</div>':'';
  // 38px element (bigger touch target) with the 26px colored disc centered; whole element taps
  return L.divIcon({className:"em",iconSize:[38,38],iconAnchor:[19,19],popupAnchor:[0,-16],
    html:'<div style="position:relative;width:26px;height:26px;margin:6px"><div style="width:26px;height:26px;border-radius:50%;background:'+col+';display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px rgba(0,0,0,.55);font-size:15px;line-height:1">'+em+'</div>'+badge+'</div>'});}
function emojiMarker(loc){var m=L.marker([loc.la,loc.lo],{icon:emojiIcon(loc),keyboard:false});
  m.on("click",function(){openLocPopup(loc);});return m;}
function updateEmojiHint(){var el=document.getElementById("emojihint");if(el)el.textContent=(emojiMode&&map.getZoom()<EMOJI_ZOOM)?"— zoom in for emoji ↗":"";}
function renderList(){
  var b=map.getBounds(),vis=curVisEst.filter(function(d){return b.contains([d.la,d.lo]);});   // only what's in view
  if(sortMode==="alpha"){vis.sort(function(a,b){return a.n.localeCompare(b.n);});}   // default: A–Z by name
  else{var flip=(METRIC&&METRIC.hiWorse===false)?-1:1;                                            // resid: higher = better, so flip
    var sv=function(d){var v=METRIC?METRIC.val(d):ratingOf(d);return v==null?-Infinity:flip*v;};  // normalized so higher = worse
    var dir=sortMode==="worst"?1:-1;                                                              // worst = desc, best = asc
    vis.sort(function(a,b){return dir*(sv(b)-sv(a))|| a.n.localeCompare(b.n);});}
  document.getElementById("count").textContent=vis.length.toLocaleString()+" places";
  var cap=Math.min(vis.length,400),h="";
  for(var i=0;i<cap;i++){var d=vis[i];
    var lead=(METRIC&&METRIC.disp)?METRIC.disp(d):LABEL[ratingOf(d)];   // the shade-by value being sorted on
    h+='<div class="item" data-id="'+esc(d.id)+'"><div class="bar" style="background:'+colorOf(d)+'"></div>'+
       '<div><div class="nm">'+esc(d.n)+'</div>'+
       '<div class="ad">'+esc(d.a||"")+(d.ci?", "+esc(d.ci):"")+'</div>'+
       '<div class="mt"><b style="color:var(--ink)">'+esc(lead)+'</b> · '+(CU_LABEL[d.cu]||"Other")+(d.dl?' · <span style="color:#6e7681;font-weight:600">Closed</span>':"")+'</div></div></div>';
  }
  if(vis.length>cap)h+='<div class="item" style="cursor:default;color:#6e7681">+ '+(vis.length-cap).toLocaleString()+' more — narrow the filters to see them</div>';
  var L2=document.getElementById("list");L2.innerHTML=h;
  L2.querySelectorAll(".item[data-id]").forEach(function(el){el.onclick=function(){focusId(el.getAttribute("data-id"));};});
}
function focusId(id){for(var i=0;i<ALL.length;i++){if(ALL[i].id===id){var d=ALL[i],loc=d._loc;if(!loc)return;
  // on mobile, collapse the filter overlay so the map shows, then center the card (not the dot) on screen
  var feed=document.getElementById("feed");
  if(window.matchMedia("(max-width:720px)").matches&&feed&&!feed.classList.contains("collapsed"))feed.classList.add("collapsed");
  openLocPopup(loc,d,"center");return;}}}
// pan so the popup CARD is centered in the map viewport (the marker ends up below center)
// after a popup opens, make sure the TOP of the card is on-screen with a small margin above it —
// scroll the map down just enough (leave it alone if the top is already visible). Keeps tall cards
// (e.g. the inspection history) from extending off the top of the screen.
function ensurePopupTop(pop){var el=pop&&pop.getElement&&pop.getElement();if(!el)return;
  var card=el.querySelector(".leaflet-popup-content-wrapper")||el,mr=map.getContainer().getBoundingClientRect(),cr=card.getBoundingClientRect();
  var top=mr.top+14;   // desired line for the card top: viewport top + 14px margin
  // on phones the title/filters panel floats over the top of the map — drop the card below its bottom edge
  var feed=document.getElementById("feed");
  if(feed&&window.matchMedia&&window.matchMedia("(max-width:720px)").matches){var fr=feed.getBoundingClientRect();if(fr.bottom+10>top)top=fr.bottom+10;}
  var dy=top-cr.top; if(dy<1)dy=0;   // px to move the card DOWN so its top clears the line (never pans up)
  // horizontal: bring the card fully on-screen, preferring the left edge so the card's start is visible
  var ml=mr.left+14,mrr=mr.right-14,dx=0;
  if(cr.left<ml)dx=ml-cr.left;             // off the left  -> slide content right
  else if(cr.right>mrr)dx=-(cr.right-mrr); // off the right -> slide content left
  if(Math.abs(dx)>1||dy>1)map.panBy([-dx,-dy],{animate:true});}   // panBy moves the view; negate to move content
// when a card is taller than the space below the header, collapse "Inspection history" first, then
// "Most recent violations", so the whole card fits on-screen without scrolling. Runs once on open.
function fitPopup(pop){var el=pop&&pop.getElement&&pop.getElement();if(!el)return;
  var card=el.querySelector(".leaflet-popup-content-wrapper")||el,mr=map.getContainer().getBoundingClientRect();
  var top=mr.top+14,feed=document.getElementById("feed");
  if(feed&&window.matchMedia&&window.matchMedia("(max-width:720px)").matches){var fr=feed.getBoundingClientRect();if(fr.bottom+10>top)top=fr.bottom+10;}
  var avail=window.innerHeight-top-14;   // vertical room for the card between the header line and the screen bottom
  var hist=el.querySelector(".sec-hist"),viol=el.querySelector(".sec-viol");
  if(hist&&card.getBoundingClientRect().height>avail)hist.open=false;   // collapse history if too tall
  if(viol&&card.getBoundingClientRect().height>avail)viol.open=false;}  // still too tall -> collapse violations too

// ── popups (lazy detail) ──────────────────────────────────────────────────────
// Google Maps URLs API — name + address as a search query resolves to the business listing without
// needing a Place ID (so no Places lookup, no key, no quota). encodeURIComponent makes it href-safe.
// The permit name often carries franchise bookkeeping that Google can't match: a store number
// ("SUBWAY #10509" finds nothing, "SUBWAY" + the address lands on the listing) or a licensee-DBA
// prefix ("JASHN 1 LLC DBA FITOOR" — the public name is what follows DBA). Strip both. The 3-digit
// floor keeps genuine names intact: "PHO #1" / "TERIYAKI #2" are what the place is actually called.
function gmapName(n){
  var s=String(n||"");
  if(/\bDBA\b/i.test(s)) s=s.split(/\bDBA\b/i).pop();
  s=s.replace(/#\s*\d{3,}\b/g,"").replace(/\s{2,}/g," ").replace(/^[\s,\-]+|[\s,\-]+$/g,"");
  return s||String(n||"");
}
// Same idea for the address: the suite/unit tail is permit bookkeeping and is often mangled
// ("13619 MUKILTEO SPEEDWAY D6 STE" is "STE D6" inverted), which is enough to miss the listing.
// The street address alone matches fine, so keep everything before the first comma and drop a
// trailing unit designator in either word order.
function gmapAddr(a){
  var s=String(a||"").split(",")[0]
    // inverted form first ("D6 STE"): the plain form would otherwise eat only the trailing "STE"
    .replace(/\s+[\w-]{1,5}\s+(?:STE|SUITE|UNIT|BLDG|APT|RM|SPC)\b\.?$/i,"")
    .replace(/\s+(?:STE|SUITE|UNIT|BLDG|APT|RM|SPC)\b\.?\s*[\w-]*$/i,"")
    .replace(/\s+#\s*[\w-]+$/,"")
    .trim();
  return s||String(a||"");
}
function gmapUrl(d){
  return "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent([gmapName(d.n),gmapAddr(d.a),d.ci,"WA",d.z].filter(Boolean).join(", "));
}
function popupShell(d){
  var r=ratingOf(d),h='<div class="pp-name"><a class="pp-gmap" href="'+gmapUrl(d)+'" target="_blank" rel="noopener" title="Look up &quot;'+esc(d.n)+'&quot; on Google Maps">'+esc(d.n)+'<svg class="exti" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-8.5 8.5M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5"/></svg></a></div>';
  h+='<span class="pp-badge" style="background:'+COLOR[r]+(r===2?";color:#1a1a00":"")+'">'+LABEL[r]+'</span>';
  if(d.dl)h+='<span class="pp-badge" style="background:#6e7681;color:#fff;margin-left:6px" title="No longer listed by the county — may have closed or changed ownership">Closed</span>';
  h+='<span class="favbtn" role="button" tabindex="0" data-fav="'+esc(d.id)+'" title="Save & get alerts when this rating changes" style="display:inline-block;margin:3px 0 3px 7px;font-size:11px;font-weight:600;padding:1px 9px;border-radius:999px;border:1px solid #f5b301;background:'+(isFav(d.id)?"#fbe7b3":"#fff")+';color:'+(isFav(d.id)?"#7a5c00":"#b8860b")+';cursor:pointer;vertical-align:middle">'+(isFav(d.id)?"★ Saved":"☆ Save")+'</span>';
  if(d.co==="k"&&d.g!=null) h+='<div class="pp-meta">Grade <b>'+d.g+'</b> ('+LABEL[d.g]+')'+(d.rs?" · "+esc(d.rs):"")+'</div>';
  if(d.s!=null) h+='<div class="pp-meta">'+(d.co==="k"?"Inspection score":"Violation points")+': <b>'+d.s+'</b> <span style="color:#999">(lower is better)</span></div>';
  if(d.ra!=null) h+='<div class="pp-meta">Avg rating, last 5 inspections: <b>'+LABEL[Math.max(1,Math.min(4,Math.round(d.ra)))]+' ('+d.ra.toFixed(1)+')</b></div>';
  if(d.wp!=null&&d.wp>(d.s||0)) h+='<div class="pp-meta">Worst inspection on record: <b>'+d.wp+'</b> pts</div>';
  h+='<div class="pp-detail"><div class="loading">Loading inspection detail…</div></div>';
  return h;
}
// drop the food-code citation paragraph(s) — the dry "(WAC 246-215-…) <code text>" block — from a
// narrative, keeping the inspector's verbatim observation above it and any corrective note below.
function cleanNote(t){if(!t)return t;
  var paras=String(t).split(/\n\s*\n/),kept=paras.filter(function(p){return !/^\s*\(\s*WAC\b/i.test(p);});
  return (kept.length?kept:paras).join("\n\n").replace(/[ \t]+\n/g,"\n").trim();}
// hidePts: Snohomish per-violation points are King's substituted values (its feed omits them), so they
// don't reconcile with Snohomish's own inspection total — show the RED/BLUE severity only, no number.
function violHtml(vs,hidePts){var s="";(vs||[]).forEach(function(x){
  var tag=x.type?'<span class="vt" style="background:'+(x.type==="RED"?"#e5484d":"#3b82f6")+'">'+esc(x.type)+((x.points!=null&&!hidePts)?" "+x.points:"")+'</span>':"";
  var head=tag+esc(x.label||"");
  // a narrative (Snohomish) collapses behind a per-violation expander so cards stay short; King items (no note) are plain rows
  var note=cleanNote(x.note);
  if(note)s+='<details class="viold"><summary>'+head+'</summary><div class="note">'+esc(note)+'</div></details>';
  else s+='<div class="viol"><div class="vh">'+head+'</div></div>';});return s;}
function detailHtml(j,co,dl){
  var h="",v=j.violations||[],hp=co==="s";   // hide King-substituted per-violation points for Snohomish
  if(dl)h+='<div class="pp-meta" style="background:#f3f4f6;border-radius:6px;padding:6px 8px;margin:2px 0 6px;color:#57606a">⚠︎ No longer listed by the county (since '+fmtDate(dl)+'). It may have closed or changed ownership — the inspection history below is what we last captured.</div>';
  // both sections are collapsible; fitPopup() collapses them as needed when the card is taller than the screen
  if(v.length)h+='<details class="pp-sec ppsec sec-viol" open><summary>Most recent violations</summary><div class="ppbody">'+violHtml(v.slice(0,8),hp)+(v.length>8?'<div style="font-size:11px;color:#888">+'+(v.length-8)+' more</div>':"")+'</div></details>';
  else h+='<details class="pp-sec ppsec sec-viol" open><summary>Most recent violations</summary><div class="ppbody"><div style="font-size:11.5px;color:#2a8a4a">No violations recorded ✓</div></div></details>';
  var hist=j.history||[];
  if(hist.length>1){h+='<details class="pp-sec ppsec sec-hist" open><summary>Inspection history <span class="hsub">tap a date for details</span></summary><div class="ppbody">';
    hist.slice(0,16).forEach(function(x){
      var left=fmtDate(x.date)+(x.label?' · '+esc(x.label):""),right=(x.score!=null?x.score+" pts":""),vs=x.v||[];
      if(vs.length)h+='<details class="histd"><summary><span class="hd">'+left+'</span><span class="hr">'+right+'</span></summary><div class="histv">'+violHtml(vs,hp)+'</div></details>';
      else h+='<div class="hist"><span>'+left+'</span><span>'+right+'</span></div>';
    });
    h+='</div></details>';}
  if(j.report_url&&!dl){var kcSearch=/kingcounty\.gov/.test(j.report_url);h+='<a class="pp-link" href="'+esc(j.report_url)+'" target="_blank" rel="noopener">'+(kcSearch?'Search King County ratings →':'Official report →')+'</a>';}
  return h;
}
function wirePopup(root,d,onLoaded){
  if(!root)return;
  var box=root.querySelector(".pp-detail");
  if(box&&!box.dataset.loaded){box.dataset.loaded="1";
    fetch("/api/detail?id="+encodeURIComponent(d.id)).then(function(r){return r.json();}).then(function(j){box.innerHTML=detailHtml(j,d.co,d.dl);
      var hds=box.querySelectorAll("details.histd");hds.forEach(function(dt){dt.addEventListener("toggle",function(){if(this.open){track("hist");hds.forEach(function(o){if(o!==dt)o.open=false;});}});});
      // violation expanders behave like an accordion: opening one closes the others
      var vds=box.querySelectorAll("details.viold");vds.forEach(function(dt){dt.addEventListener("toggle",function(){if(this.open)vds.forEach(function(o){if(o!==dt)o.open=false;});});});
      if(onLoaded)onLoaded();}).catch(function(){box.innerHTML="";if(onLoaded)onLoaded();});}
  else if(onLoaded)onLoaded();
  // let the navigation proceed (target=_blank); just stop the click reaching the map and log the tap
  var gm=root.querySelector(".pp-gmap");
  if(gm)gm.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();track("gmap",d.co,CU_LABEL[d.cu]||"Other",d.n);};
  var fb=root.querySelector(".favbtn");
  if(fb)fb.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();var on=toggleFav(d.id,d);fb.textContent=on?"★ Saved":"☆ Save";fb.style.background=on?"#fbe7b3":"#fff";fb.style.color=on?"#7a5c00":"#b8860b";};
}
function bindPopupOpen(m,d){m.on("popupopen",function(e){wirePopup(e.popup.getElement(),d);});}
// popup for a location: 1 establishment -> its detail; several -> a tappable list -> drill into detail
function locListHtml(vm){
  var a=vm[0],h='<div class="pp-name">'+vm.length+' establishments here</div>';
  h+='<div class="pp-addr">'+esc(a.a||"")+(a.ci?", "+esc(a.ci):"")+(a.z?" "+esc(a.z):"")+'</div>';
  h+='<div style="max-height:250px;overflow:auto;margin-top:6px">';
  vm.forEach(function(d,i){
    // color the disc + label by the ACTIVE shade metric (not always latest rating) so the popup
    // matches the map bubble — e.g. in "Last routine rating" mode this shows each place's routine
    // rating, the same metric the cluster color is computed from.
    var disc=colorOf(d), lab=(METRIC&&METRIC.disp)?METRIC.disp(d):LABEL[ratingOf(d)];
    h+='<div class="loc-row" data-i="'+i+'" style="display:flex;align-items:center;gap:8px;padding:6px 2px;border-top:1px solid #eee;cursor:pointer">'
      +'<span style="width:22px;height:22px;border-radius:50%;background:'+disc+';display:flex;align-items:center;justify-content:center;font-size:13px;flex:none">'+(CU_EMOJI[d.cu]||"🍴")+'</span>'
      +'<span style="flex:1;min-width:0"><b style="font-size:12.5px;color:#111">'+esc(d.n)+'</b><br><span style="color:#777;font-size:11px">'+esc(lab)+' · '+(CU_LABEL[d.cu]||"Other")+(d.dl?' · Closed':"")+'</span></span>'
      +'<span style="color:#bbb;font-size:16px">›</span></div>';});
  return h+'</div>';
}
function openLocPopup(loc,focusD,mode){
  var vm=loc.m.filter(passes);if(!vm.length)return;
  vm.sort(function(a,b){return reprWorseness(b)-reprWorseness(a)||a.n.localeCompare(b.n);});   // worst-on-active-metric first (matches the cluster's representative color)
  // we manage panning ourselves (ensurePopupTop) so the card top is always visible, incl. tall cards
  var pop=L.popup({maxWidth:300,minWidth:280,autoPan:false}).setLatLng([loc.la,loc.lo]).openOn(map);
  function showList(){pop.setContent(locListHtml(vm));setTimeout(function(){var root=pop.getElement();if(!root)return;
    root.querySelectorAll(".loc-row").forEach(function(el){el.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();showDetail(vm[+el.dataset.i]);};});ensurePopupTop(pop);},0);}
  function showDetail(d){track("open",d.co,CU_LABEL[d.cu]||"Other",d.n);pop.setContent((vm.length>1?'<div class="loc-back" style="margin-bottom:6px;font-size:11.5px;color:#0969da;cursor:pointer">&larr; '+vm.length+' at this address</div>':'')+popupShell(d));
    setTimeout(function(){var root=pop.getElement();if(!root)return;wirePopup(root,d,function(){fitPopup(pop);ensurePopupTop(pop);});var b=root.querySelector(".loc-back");if(b)b.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();showList();};ensurePopupTop(pop);},0);}
  if(vm.length===1)showDetail(vm[0]);
  else if(focusD&&vm.indexOf(focusD)>=0)showDetail(focusD);
  else showList();
}

// ── load ──────────────────────────────────────────────────────────────────────
fetch("/api/establishments?v="+DATA_VERSION).then(function(r){return r.json();}).then(function(j){
  ALL=j.items||[];
  var ages=[],wps=[],counts={k:0,s:0},cu={},csum={},cn={};
  ALL.forEach(function(d){counts[d.co]++;cu[d.cu]=(cu[d.cu]||0)+1;var a=ageOf(d);if(a!=null)ages.push(a);if(d.wp!=null)wps.push(d.wp);
    var base=d.ra!=null?d.ra:(d.r==null?null:d.r);if(base!=null){csum[d.cu]=(csum[d.cu]||0)+base;cn[d.cu]=(cn[d.cu]||0)+1;}});   // per-FINE-cuisine mean for the residual
  CUMEAN={};for(var ck in csum)if(cn[ck]>=8)CUMEAN[ck]=csum[ck]/cn[ck];   // need a few peers for a meaningful norm
  maxAge=Math.min(40,Math.max.apply(0,ages.concat(20)));
  WPMAX=Math.ceil(Math.max.apply(0,wps.concat(100))/10)*10;
  buildMetrics();
  // markers
  // cluster establishments at (nearly) the same point — within ~12 m — into one marker, so
  // sub-metre geocoding splits (strip malls, food courts, suites) don't hide one under another
  LOC=clusterLocations(ALL,12);
  MARK=LOC.map(function(loc){var mk=L.circleMarker([loc.la,loc.lo],{renderer:canvas,radius:7,weight:1,color:"#0b0b0b",fillColor:"#888",fillOpacity:.9});
    mk.on("click",function(){openLocPopup(loc);});return mk;});
  // cuisine dropdown (sorted by count)
  var sel=document.getElementById("cuisine");
  var favOpt=document.createElement("option");favOpt.value="__fav";favOpt.textContent="★ Saved";sel.appendChild(favOpt);   // top item, under "All cuisines"
  Object.keys(cu).sort(function(a,b){return (CU_LABEL[a]||a).localeCompare(CU_LABEL[b]||b);}).forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=(CU_LABEL[k]||k)+" ("+cu[k]+")";sel.appendChild(o);});
  sel.onchange=function(){if(sel.value==="__fav"){favOnly=true;fCuisine="";}else{favOnly=false;fCuisine=sel.value;}render();track("filter",sel.value==="__fav"?"saved":(sel.value||"all"));};
  // range filter — follows the shade-by metric (rebuilt by applyMetric)
  applyMetric(colorMode);
  // shade-by dropdown: re-point the range filter at the new metric, then recolor
  document.getElementById("colorby").onchange=function(){colorMode=this.value;applyMetric(colorMode);updateSortLabel();recolor();track("shade",this.value);};
  if(j.updated){var u=new Date(j.updated);document.getElementById("upd").textContent="Updated "+(isNaN(u)?j.updated:u.toLocaleDateString());}
  render();renderLegend();
  // restore the prior view+filters when returning from /about, /stats, or an auto-reload; else fit the region
  var rv=null;try{rv=JSON.parse(sessionStorage.getItem("snoking_view")||"null");sessionStorage.removeItem("snoking_view");}catch(e){}
  if(rv&&Date.now()-rv.t<1800000){restoreView(rv);}
  else{var la=ALL.map(function(d){return d.la;}),lo=ALL.map(function(d){return d.lo;});
    if(ALL.length)map.fitBounds([[Math.min.apply(0,la),Math.min.apply(0,lo)],[Math.max.apply(0,la),Math.max.apply(0,lo)]],{padding:[20,20]});}
  applyUrlIntent();
  track("app",standalone()?"installed":"browser");
  // capture where this visit came from (RUM beacon doesn't expose it to us) — host only, no full URL
  try{var rf=document.referrer;if(rf){var rh=new URL(rf).hostname||rf;if(rh&&rh!==location.hostname)track("ref",rh);}else track("ref","(direct)");}catch(e){}
  // capture a campaign tag from the URL: short ?ref=<tag>, or standard utm_source/campaign/content.
  // lets you attribute a visit to a specific FB group / Reddit post / etc. (referrers can't — FB strips the path)
  try{var qp0=new URLSearchParams(location.search),tag=qp0.get("ref");
    if(!tag){var pp=[qp0.get("utm_source"),qp0.get("utm_campaign"),qp0.get("utm_content")].filter(Boolean);if(pp.length)tag=pp.join("/");}
    if(tag){track("src",String(tag).slice(0,60));
      ["ref","utm_source","utm_campaign","utm_medium","utm_content","utm_term"].forEach(function(k){qp0.delete(k);});   // strip so a reload/bookmark doesn't recount (keeps ?focus= etc.)
      var qs=qp0.toString();history.replaceState(null,"",location.pathname+(qs?"?"+qs:"")+location.hash);}}catch(e){}
});
var qt;document.getElementById("q").oninput=function(e){clearTimeout(qt);var v=e.target.value.toLowerCase();qt=setTimeout(function(){setQuery(v);render();fitSearch();},180);};
// a search filters dots in place but the matches may be off-screen (and the list is viewport-only),
// so a place looks "missing". When a specific search's matches are all off-screen, pan/zoom to them.
function fitSearch(){
  if(!query)return;
  var ms=ALL.filter(passes).filter(function(d){return d.la!=null&&d.lo!=null;});
  if(!ms.length||ms.length>60)return;                                    // nothing, or too broad to be a real lookup
  var b=map.getBounds();
  if(ms.some(function(d){return b.contains([d.la,d.lo]);}))return;        // a match is already visible — leave the map alone
  if(ms.length===1){map.setView([ms[0].la,ms[0].lo],16);return;}
  var la=ms.map(function(d){return d.la;}),lo=ms.map(function(d){return d.lo;});
  map.fitBounds([[Math.min.apply(0,la),Math.min.apply(0,lo)],[Math.max.apply(0,la),Math.max.apply(0,lo)]],{padding:[40,40],maxZoom:16});
}
// when focus leaves the search field and it has text, show an in-field clear button (left of the text);
// clicking it clears the field, re-renders, and re-focuses the field
(function(){var q=document.getElementById("q"),qc=document.getElementById("qclear");
  q.addEventListener("blur",function(){if(q.value){qc.style.display="block";q.classList.add("hasclear");track("search");}});
  q.addEventListener("focus",function(){qc.style.display="none";q.classList.remove("hasclear");});
  qc.addEventListener("click",function(){clearTimeout(qt);q.value="";setQuery("");render();q.focus();});})();
// flip the list sort order (worst-first <-> best-first) by clicking the "worst first" label
// time-based metrics ("recently changed", "years in operation") read newest/oldest; every other metric reads worst/best
function sortLabel(){if(sortMode==="alpha")return "A–Z";if(colorMode==="changed")return sortMode==="worst"?"newest first":"oldest first";if(colorMode==="age")return sortMode==="worst"?"oldest first":"newest first";return sortMode==="worst"?"worst first":"best first";}
function updateSortLabel(){var el=document.getElementById("sortdir");if(!el)return;
  if(colorMode==="cuisine"){sortMode="alpha";el.textContent="A–Z";el.style.cursor="default";el.style.textDecoration="none";el.title="";}   // cuisine is categorical — no best/worst ordering
  else{el.textContent=sortLabel();el.style.cursor="pointer";el.style.textDecoration="underline dotted";el.title="Click to change sort";}}
document.getElementById("sortdir").onclick=function(){if(colorMode==="cuisine")return;sortMode=sortMode==="alpha"?"best":(sortMode==="best"?"worst":"alpha");updateSortLabel();renderList();};
// click the title bar to collapse/expand the filter+list panel (frees the map, esp. on mobile)
document.getElementById("head").onclick=function(e){if(e.target.id==="q"||e.target.tagName==="INPUT"||e.target.closest(".statslink"))return;
  if(!window.matchMedia("(max-width:720px)").matches)return;   // collapse only on mobile
  document.getElementById("feed").classList.toggle("collapsed");
  setTimeout(function(){map.invalidateSize();},210);};
// 📍 locate the user, drop a marker, and zoom in
var meMarker=null;
document.getElementById("loc").onclick=function(e){e.stopPropagation();var btn=this;track("locate");
  if(!navigator.geolocation){alert("Location isn't available in this browser.");return;}
  btn.classList.add("locating");
  navigator.geolocation.getCurrentPosition(function(p){btn.classList.remove("locating");
    var la=p.coords.latitude,lo=p.coords.longitude;
    if(meMarker)map.removeLayer(meMarker);
    // a non-interactive DOM marker (NOT a canvas circleMarker — that would spawn a second
    // full-map canvas in markerPane and swallow clicks on the dots underneath)
    meMarker=L.marker([la,lo],{interactive:false,keyboard:false,icon:L.divIcon({className:"me",iconSize:[20,20],iconAnchor:[10,10],
      html:'<div style="width:18px;height:18px;border-radius:50%;background:#1d6ef2;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4)"></div>'})}).addTo(map);
    map.setView([la,lo],16);
  },function(err){btn.classList.remove("locating");alert("Couldn't get your location: "+err.message);},
  {enableHighAccuracy:true,timeout:10000,maximumAge:60000});};
// nav-link click tracking (sendBeacon fires before navigation): each page open is its own event type
[["lnk-stats","stats"],["lnk-bloop","bloopers"],["about","about"]].forEach(function(p){
  var el=document.getElementById(p[0]);if(el)el.addEventListener("click",function(){track(p[1]);});});
// in emoji mode, re-cull to the new viewport (and switch dots<->emoji across the zoom threshold).
// DEBOUNCED: a tap on mobile jitters the map slightly -> moveend; without the delay the re-cull
// would destroy the tapped marker before its click lands, so taps never register. The delay lets
// the click fire (opening the popup, which then suppresses the re-cull) first.
var reCull=null;
map.on("moveend",function(){renderList();   // list follows the visible map region
  if(!emojiMode)return;clearTimeout(reCull);reCull=setTimeout(function(){if(emojiMode&&!popupOpen)drawMarkers(lastVis);},220);});
map.on("popupopen",function(){popupOpen=true;clearTimeout(reCull);document.body.classList.add("popup-open");});   // hide legend/zoom so they don't cover the card
map.on("popupclose",function(){popupOpen=false;document.body.classList.remove("popup-open");if(emojiMode)drawMarkers(lastVis);});
// ── favorites (stored locally, no login) + push alerts ──
var FAVKEY="snoking_favs", favOnly=false, VAPID_PUBLIC="BLUPpCG20smyXKX1k3fCvNd-7VyRHWjpIriPjy56_yc2-GotKcWD750ID015AQa4yYwdZSjBeq-LRBl3eEz0F9I";
function getFavs(){try{return JSON.parse(localStorage.getItem(FAVKEY)||"[]");}catch(e){return [];}}
function isFav(id){return getFavs().indexOf(id)>=0;}
function toggleFav(id,d){var f=getFavs(),i=f.indexOf(id);if(i>=0)f.splice(i,1);else f.push(id);localStorage.setItem(FAVKEY,JSON.stringify(f));syncPush();if(favOnly)render();track("fav",i<0?"add":"remove",d?(CU_LABEL[d.cu]||"Other"):"",d?d.n:"");return i<0;}
function pushSupported(){return ("serviceWorker" in navigator)&&("PushManager" in window)&&("Notification" in window);}
// anonymous product-usage event (no PII): which views/filters/features people use
function track(n,l,l2,l3){try{var o={n:n,l:l||""};if(l2)o.l2=l2;if(l3)o.l3=l3;var b=JSON.stringify(o);if(navigator.sendBeacon)navigator.sendBeacon("/ev",b);else fetch("/ev",{method:"POST",body:b,keepalive:true});}catch(e){}}
function urlB64ToU8(s){var pad="=".repeat((4-s.length%4)%4),b=atob((s+pad).replace(/-/g,"+").replace(/_/g,"/")),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
function pushOn(){return localStorage.getItem("snoking_push")==="1";}
function updateBell(){var el=document.getElementById("bell");if(el)el.style.opacity=pushOn()?"1":".4";}
function getSub(){return ("serviceWorker" in navigator)?navigator.serviceWorker.ready.then(function(reg){return reg.pushManager.getSubscription();}):Promise.resolve(null);}
function syncPush(){if(!pushOn())return;getSub().then(function(sub){if(!sub)return;fetch("/push/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({subscription:sub.toJSON(),favorites:getFavs()})}).catch(function(){});});}
function iOS(){return /iP(hone|ad|od)/.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1);}
function standalone(){return window.matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;}
// no pre-dialogs — tapping the bell goes straight to the OS/iOS permission prompt; the bell
// lighting up is the confirmation. Denials/failures are silent (the bell just stays dim).
function enablePush(){
  if(!pushSupported())return;
  Notification.requestPermission().then(function(perm){
    if(perm!=="granted")return;
    return navigator.serviceWorker.ready
      .then(function(reg){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToU8(VAPID_PUBLIC)});})
      .then(function(sub){return fetch("/push/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({subscription:sub.toJSON(),favorites:getFavs()})});})
      .then(function(){localStorage.setItem("snoking_push","1");updateBell();track("alerts","on");});
  }).catch(function(e){console.log("enable alerts failed",e);});
}
function disablePush(){getSub().then(function(sub){if(sub){fetch("/push/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:sub.endpoint})}).catch(function(){});sub.unsubscribe();}localStorage.removeItem("snoking_push");updateBell();track("alerts","off");});}
function applyUrlIntent(search){
  var qp=new URLSearchParams(search!=null?search:location.search);
  if(qp.get("changed")){var s=document.getElementById("colorby");if(s){s.value="changed";colorMode="changed";applyMetric("changed");updateSortLabel();recolor();}}
  var fid=qp.get("focus");
  if(fid){for(var i=0;i<ALL.length;i++){if(ALL[i].id===fid){map.setView([ALL[i].la,ALL[i].lo],17);setTimeout(function(){focusId(fid);},350);break;}}}
}
// tapping a notification while the app is already open: open that restaurant's card without reloading
if("serviceWorker" in navigator)navigator.serviceWorker.addEventListener("message",function(e){
  if(e.data&&e.data.type==="notif-open"&&e.data.url){var u=new URL(e.data.url,location.origin);
    try{history.replaceState(null,"",u.pathname+u.search);}catch(x){}
    applyUrlIntent(u.search);}
});
// auto-refresh the map data when it changes (the daily ingest) and the app returns to the foreground,
// so no force-quit is needed. Re-fetch happens IN PLACE — current map position, zoom, and filters are
// preserved. Cheap: a tiny /api/version probe, full re-fetch only when the version actually moved.
function refreshData(newVer){
  fetch("/api/establishments?v="+newVer).then(function(r){return r.json();}).then(function(j){
    DATA_VERSION=newVer; ALL=j.items||[];
    var csum={},cn={};
    ALL.forEach(function(d){var base=d.ra!=null?d.ra:(d.r==null?null:d.r);if(base!=null){csum[d.cu]=(csum[d.cu]||0)+base;cn[d.cu]=(cn[d.cu]||0)+1;}});
    CUMEAN={};for(var ck in csum)if(cn[ck]>=8)CUMEAN[ck]=csum[ck]/cn[ck];
    LOC=clusterLocations(ALL,12);
    MARK=LOC.map(function(loc){var mk=L.circleMarker([loc.la,loc.lo],{renderer:canvas,radius:7,weight:1,color:"#0b0b0b",fillColor:"#888",fillOpacity:.9});mk.on("click",function(){openLocPopup(loc);});return mk;});
    render();renderLegend();
    if(j.updated){var u=new Date(j.updated);document.getElementById("upd").textContent="Updated "+(isNaN(u)?j.updated:u.toLocaleDateString());}
  }).catch(function(){});
}
var lastVerCheck=0;
function checkForUpdate(){
  if(document.visibilityState!=="visible")return;
  var now=Date.now();if(now-lastVerCheck<30000)return;lastVerCheck=now;   // throttle repeated foregrounds
  fetch("/api/version").then(function(r){return r.json();}).then(function(j){
    if(!j)return;
    if(j.b&&encodeURIComponent(j.b)!==BUILD_VERSION){   // a new build is deployed -> reload to pick up new code (no force-quit)
      saveView();location.reload();return;
    }
    if(j.v&&encodeURIComponent(j.v)!==DATA_VERSION)refreshData(encodeURIComponent(j.v));
  }).catch(function(){});
}
document.addEventListener("visibilitychange",checkForUpdate);
// save the view whenever we leave the page (navigating to /about, /stats, etc.) so "back to map" restores it
window.addEventListener("pagehide",saveView);
// actual PWA install moment (Android/desktop fire this; iOS "Add to Home Screen" does not)
window.addEventListener("appinstalled",function(){track("install");});
// hide the bell entirely on browsers without web-push support; otherwise wire enable/disable
var bellEl=document.getElementById("bell");
if(!pushSupported()){if(bellEl)bellEl.style.display="none";}
else{bellEl.onclick=function(e){e.stopPropagation();if(pushOn())disablePush();else enablePush();};updateBell();}
// register the service worker so the app is installable / works offline (PWA)
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(function(){});
</script><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "4038d69ec05f4dff86953ee46d95bcdd"}'></script></body></html>`;

// ============================ /stats — choropleth ============================
// Average restaurant rating by census tract, with a demographic-residual mode
// (is an area's food safety better/worse than its demographics predict?), modeled
// on the dispatch /rates page. Tracts only (King + Snohomish). Cuisine-filterable.
const STATS_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ratings">
<link rel="apple-touch-icon" href="/icon-180.png?v=7">
<title>Sno/King Food Safety — Ratings by Area</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#2a3038;--accent:#3b82f6}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  #wrap{display:flex;height:100%}
  #panel{width:300px;min-width:300px;box-sizing:border-box;padding:calc(14px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 14px calc(16px + env(safe-area-inset-left));background:var(--panel);border-right:1px solid var(--line);overflow-y:auto}
  #map{flex:1;height:100%;background:#e8eaed}
  h1{font-size:16px;margin:0 0 2px} a{color:#58a6ff;text-decoration:none}
  .muted{color:var(--muted);font-size:11.5px} b{color:var(--ink)}
  .field{margin:13px 0} .field>label{display:block;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
  select{width:100%;padding:8px 9px;border-radius:7px;border:1px solid var(--line);background:#0d1117;color:var(--ink);font-size:12.5px}
  .seg{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
  .seg button{flex:1;padding:8px 6px;border:0;border-left:1px solid var(--line);background:#0d1117;color:var(--muted);font:12.5px system-ui;cursor:pointer}
  .seg button:first-child{border-left:0}
  .seg button.on{background:#222b38;color:var(--ink);font-weight:600}
  /* collapsible filters (same show/hide UI as the main map) */
  #head{cursor:pointer;user-select:none}
  #head h1{display:flex;align-items:center;gap:8px}
  #head .muted{margin-top:3px}
  h1 .tog{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#fff;background:var(--accent);padding:6px 12px;border-radius:999px;line-height:1}
  @media(min-width:721px){h1 .tog{display:none}}   /* panel is always open on desktop — no toggle needed */
  h1 .tog b{font-size:15px;line-height:1;transition:transform .15s;display:inline-block}
  #panel:not(.collapsed) h1 .tog b{transform:rotate(180deg)}
  #panel.collapsed #controls{display:none}
  .legend i{display:inline-block;width:13px;height:13px;margin-right:7px;vertical-align:-2px;border:1px solid #0006;border-radius:2px}
  .legend div{line-height:20px;font-size:12px}
  .crow{cursor:pointer;display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;font-size:11.5px}
  .crow:hover{background:#1d242e}
  .crow.on{background:#222b38}
  .leaflet-popup-content{font:12px system-ui;color:#111;width:220px!important}
  .leaflet-popup-content b{color:#000}
  @media (max-width:720px){
    /* full-screen map with the filter panel floating over it (same as the main map), so the
       map always uses the whole space and the expanded panel scrolls instead of squashing it */
    #wrap{display:block;position:relative}
    #map{position:absolute;inset:0;height:100%;width:100%}
    #panel{position:absolute;top:0;left:0;right:0;z-index:1000;width:auto;min-width:0;max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-right:0;border-bottom:1px solid var(--line);box-shadow:0 10px 28px rgba(0,0,0,.45)}
    #panel.collapsed{max-height:none;overflow:visible;box-shadow:none}
  }
</style></head><body>
<div id="wrap">
  <div id="panel">
    <div id="head">
      <h1>Ratings by area <span class="tog" id="tog" title="Show/hide filters">Filters <b>&#9662;</b></span></h1>
      <div class="muted"><a href="/">&larr; back to the restaurant map</a></div>
    </div>
    <div id="controls">
    <div class="field">
      <label>Aggregate by</label>
      <div class="seg" id="aggby">
        <button type="button" data-v="tract">Census tracts</button>
        <button type="button" data-v="geohash" class="on">Geohash tiles</button>
      </div>
    </div>
    <div class="field">
      <label>Color by</label>
      <div class="seg" id="shadeby">
        <button type="button" data-v="rating" class="on">Avg rating</button>
        <button type="button" data-v="resid">vs cuisine norm</button>
      </div>
    </div>
    <div class="field">
      <label>Cuisine</label>
      <select id="cuisine"><option value="">All restaurants</option></select>
    </div>
    <div class="field">
      <label>Rating basis</label>
      <select id="basis">
        <option value="avg5">Average of last 5 inspections</option>
        <option value="last">Most recent inspection</option>
        <option value="all">Average of all inspections</option>
      </select>
    </div>
    <div class="field">
      <div id="title" class="muted" style="margin-bottom:6px"></div>
      <div id="legend" class="legend"></div>
    </div>
    <div class="field muted" id="desc">Establishments are binned into <b>geohash tiles</b> shaded by their mean rating (1 = Excellent … 4 = Needs to Improve; lower is better); tiles <b>subdivide as you zoom in</b>.</div>
    <div class="field muted" id="cov"></div>
    </div>
  </div>
  <div id="map"></div>
</div>
<script>
var DATA_VERSION="__DATA_VERSION__";
var CU_ORDER=["pizza","mexican","chinese","japanese","teriyaki","thai","vietnamese","korean","indian","mediterranean","italian","bbq","burgers","chicken","sandwich","seafood","coffee","bakery","bar","grocery","fastfood","cafe_diner","school","seniorcare","hotel","catering","foodtruck","venue","workplace","other"];
var CU_LABEL={pizza:"Pizza",mexican:"Mexican",chinese:"Chinese",japanese:"Japanese / Sushi",teriyaki:"Teriyaki",thai:"Thai",vietnamese:"Vietnamese",korean:"Korean",indian:"Indian",mediterranean:"Mediterranean",italian:"Italian",bbq:"BBQ",burgers:"Burgers",chicken:"Chicken",sandwich:"Sandwich / Deli",seafood:"Seafood",coffee:"Coffee / Tea",bakery:"Bakery / Dessert",bar:"Bar / Pub",grocery:"Grocery / Market",fastfood:"Fast Food",cafe_diner:"Cafe / Diner",school:"School / Education",seniorcare:"Senior / Care",hotel:"Hotel / Lodging",catering:"Catering",foodtruck:"Food Truck / Mobile",venue:"Venue / Workplace",workplace:"Workplace / Cafeteria",other:"Other"};
var BASIS_LAB={avg5:"avg of last 5 inspections",last:"most recent inspection",all:"avg of all inspections"};
var PAL=["#1a9850","#a6d96a","#fee08b","#fc8d59","#d73027"];                 // good(low avg)->bad(high)
var FLOOR=4;   // min restaurants in a tract to shade it (noise control)
var FLOOR_GH=2;   // min establishments in a geohash tile to shade it
var POINTS=null, ghLayer=null;
function q(id){return document.getElementById(id);}
function fmtAvg(v){return v.toFixed(2);}
// base-32 geohash encode that also returns the cell's lat/lon bounds (for drawing the tile)
var GH32="0123456789bcdefghjkmnpqrstuvwxyz";
function geohashCell(lat,lon,prec){var latR=[-90,90],lonR=[-180,180],hash="",bit=0,ch=0,even=true;
  while(hash.length<prec){
    if(even){var m=(lonR[0]+lonR[1])/2;if(lon>=m){ch=(ch<<1)+1;lonR[0]=m;}else{ch=ch<<1;lonR[1]=m;}}
    else{var m2=(latR[0]+latR[1])/2;if(lat>=m2){ch=(ch<<1)+1;latR[0]=m2;}else{ch=ch<<1;latR[1]=m2;}}
    even=!even;if(++bit===5){hash+=GH32[ch];bit=0;ch=0;}}
  return{hash:hash,s:latR[0],n:latR[1],w:lonR[0],e:lonR[1]};}
function ghPrec(z){return z<=8?4:z<=10?5:z<=12?6:z<=14?7:8;}   // finer tiles as you zoom in
function pRating(p){var b=q("basis").value;return b==="last"?p.r:(b==="all"?(p.aa!=null?p.aa:p.r):(p.ra!=null?p.ra:p.r));}

// see the main map: no +/- buttons, but the basemap credit stays on the map as the license requires
var map=L.map("map",{preferCanvas:true,zoomControl:false}).setView([47.75,-122.1],9);
// Esri Light Gray Canvas, not CARTO: CARTO started stamping "API KEY REQUIRED" diagonally across
// unauthenticated basemap tiles, and this is the closest keyless muted base. A muted base is the
// whole point here — the tract/geohash fills carry the information, so the basemap has to stay out
// of their way. Esri ships labels as a separate layer, which is an improvement: they go in a pane
// ABOVE the choropleth so city names stay legible through the fills, with pointer-events off so
// clicks still reach the polygons. Only cached to z16; maxNativeZoom lets Leaflet upscale past it.
var ESRI="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_{v}/MapServer/tile/{z}/{y}/{x}";
L.tileLayer(ESRI.replace("{v}","Base"),{maxZoom:18,maxNativeZoom:16,attribution:'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'}).addTo(map);
map.createPane("labels");map.getPane("labels").style.zIndex=450;map.getPane("labels").style.pointerEvents="none";
L.tileLayer(ESRI.replace("{v}","Reference"),{maxZoom:18,maxNativeZoom:16,pane:"labels"}).addTo(map);
map.attributionControl.setPrefix("");
var regions=null, statByRegion={}, gl=null, breaks=[], fitted=false;

(function(){var s=q("cuisine");CU_ORDER.forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=CU_LABEL[k]||k;s.appendChild(o);});})();

var aggMode="geohash", shadeMode="rating";   // shadeMode: rating | resid (vs cuisine norm)
function colorPlain(v){for(var i=breaks.length-1;i>=0;i--){if(v>=breaks[i])return PAL[i];}return PAL[0];}
var RPAL=["#d73027","#fc8d59","#dcdcdc","#91cf60","#1a9850"];   // residual diverging: worse(red) … better(green)
function colorResid(v){for(var i=breaks.length-1;i>=0;i--){if(v>=breaks[i])return RPAL[i];}return RPAL[0];}
function cellColor(v){return shadeMode==="resid"?colorResid(v):colorPlain(v);}
function sgn(v){return (v>=0?"+":"")+v.toFixed(2);}
// per-FINE-cuisine mean rating on the current basis (over ALL points) → the residual baseline
var CUMEAN={}, cumeanBasis=null;
function cuMean(){var b=q("basis").value;if(cumeanBasis===b)return CUMEAN;var s={},c={};
  (POINTS||[]).forEach(function(p){var v=pRating(p);if(v==null)return;s[p.cu]=(s[p.cu]||0)+v;c[p.cu]=(c[p.cu]||0)+1;});
  CUMEAN={};for(var k in s)if(c[k]>=8)CUMEAN[k]=s[k]/c[k];cumeanBasis=b;return CUMEAN;}   // need ≥8 peers for a norm
function residP(p,mu){var m=mu[p.cu];if(m==null)return null;var v=pRating(p);return v==null?null:(m-v);}   // + = better than peers
function statOf(f){return statByRegion[f.properties.region_id];}
function styleFor(f){var s=statOf(f);
  if(!s||s.n<FLOOR||s.avg==null)return{fillOpacity:0,color:"#888",weight:.3};
  return{fillColor:cellColor(s.avg),fillOpacity:.62,color:"#777",weight:.4};}
function popHtml(f){var p=f.properties,s=statOf(f)||{};
  var h="<b>"+esc(p.name||p.region_id)+"</b><br>"+(p.county||"")+" County · pop "+((p.population||0).toLocaleString());
  if(s.n)h+="<br><b>"+s.n+"</b> "+(q("cuisine").value?CU_LABEL[q("cuisine").value]+" ":"")+"establishments";
  if(s.avg!=null)h+=shadeMode==="resid"
    ?"<br><b>"+sgn(s.avg)+"</b> vs cuisine norm "+(s.avg>=0?"(beats it)":"(trails it)")
    :"<br>avg rating <b>"+fmtAvg(s.avg)+"</b> / 4 "+(s.n<FLOOR?"<span style='color:#888'>(too few to map)</span>":"");
  return h;}
function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
// quantile breaks for whichever value (rating or residual) is in statByRegion / the tiles
function mkBreaks(vals){vals.sort(function(a,b){return a-b;});
  var br=[vals.length?vals[0]:0];for(var i=1;i<5;i++)br[i]=vals.length?vals[Math.floor(i/5*vals.length)]:i;
  for(i=1;i<5;i++)if(br[i]<=br[i-1])br[i]=br[i-1]+1e-4;return br;}

function render(){   // tract choropleth — statByRegion already built (rating or residual)
  var vals=[];regions.features.forEach(function(f){var s=statOf(f);if(s&&s.n>=FLOOR&&s.avg!=null)vals.push(s.avg);});
  breaks=mkBreaks(vals);
  if(gl)gl.remove();
  gl=L.geoJSON(regions,{style:styleFor,onEachFeature:function(f,l){l.bindPopup(popHtml(f));}}).addTo(map);
  if(!fitted){map.fitBounds(gl.getBounds(),{padding:[20,20]});fitted=true;}
  drawLegend();
}
function drawLegend(){
  var resid=shadeMode==="resid",pal=resid?RPAL:PAL,fmt=resid?sgn:fmtAvg;
  q("title").innerHTML=(resid?"Residual vs cuisine norm":"Mean rating")+" ("+BASIS_LAB[q("basis").value]+") · "+(q("cuisine").value?CU_LABEL[q("cuisine").value]:"all restaurants");
  var h="";for(var i=4;i>=0;i--){h+="<div><i style='background:"+pal[i]+"'></i>"+fmt(breaks[i])+(i<4?" – "+fmt(breaks[i+1]):"+")+(resid?(i===4?" (beats norm)":(i===0?" (trails)":"")):"")+"</div>";}
  h+="<div><i style='border:1px solid #888;background:transparent'></i>&lt; "+FLOOR+" establishments</div>";q("legend").innerHTML=h;
}

// ── geohash-tile aggregation (client-side; tiles subdivide as you zoom) ──────────
function renderGeohash(){
  if(!POINTS){loadPoints();return;}
  var cu=q("cuisine").value, prec=ghPrec(map.getZoom()), listMode=prec>=6, resid=shadeMode==="resid", mu=resid?cuMean():null, cells={};
  for(var i=0;i<POINTS.length;i++){var p=POINTS[i];if(cu&&p.cu!==cu)continue;var v=resid?residP(p,mu):pRating(p);if(v==null)continue;
    var c=geohashCell(p.la,p.lo,prec),b=cells[c.hash];
    if(!b){b=cells[c.hash]={s:c.s,n:c.n,w:c.w,e:c.e,sum:0,k:0,items:listMode?[]:null};}
    b.sum+=v;b.k++;if(listMode)b.items.push({n:p.n,v:v});}
  var arr=[];for(var h in cells){var b=cells[h];if(b.k>=FLOOR_GH){b.avg=b.sum/b.k;arr.push(b);}}
  breaks=mkBreaks(arr.map(function(x){return x.avg;}));
  if(ghLayer)ghLayer.remove();
  ghLayer=L.layerGroup();
  arr.forEach(function(b){var rect=L.rectangle([[b.s,b.w],[b.n,b.e]],{fillColor:cellColor(b.avg),fillOpacity:.55,color:"#777",weight:.3});
    if(listMode)rect.bindPopup(tilePopup.bind(null,b),{maxWidth:300,minWidth:230});
    else rect.bindPopup("<b>"+b.k+"</b> establishments<br>"+(resid?"<b>"+sgn(b.avg)+"</b> vs cuisine norm":"avg rating <b>"+fmtAvg(b.avg)+"</b> / 4"));
    rect.addTo(ghLayer);});
  ghLayer.addTo(map);
  drawLegend();
  q("cov").innerHTML=arr.length.toLocaleString()+" geohash tiles (precision "+prec+", &ge; "+FLOOR_GH+" establishments each). Zoom in to subdivide"+(listMode?"; tap a tile for its establishments.":".");
}
// list a tile's establishments with each one's value (worst first)
function tilePopup(b){
  var resid=shadeMode==="resid",items=b.items.slice().sort(function(x,y){return resid?(x.v-y.v):(y.v-x.v);}),cap=Math.min(items.length,40);
  var h="<b>"+b.k+"</b> establishments · "+(resid?"<b>"+sgn(b.avg)+"</b> vs cuisine norm":"avg <b>"+fmtAvg(b.avg)+"</b> / 4")+" <span style='color:#888'>("+BASIS_LAB[q("basis").value]+")</span>"
       +"<div style='max-height:210px;overflow:auto;margin-top:5px'>";
  for(var i=0;i<cap;i++){var it=items[i];
    h+="<div style='display:flex;justify-content:space-between;gap:8px;border-top:1px solid #eee;padding:3px 0'>"
      +"<span style='color:#111;min-width:0'>"+esc(it.n)+"</span>"
      +"<b style='color:"+cellColor(it.v)+";flex:none'>"+(resid?sgn(it.v):it.v.toFixed(1))+"</b></div>";}
  if(items.length>cap)h+="<div style='color:#888;padding-top:3px'>+ "+(items.length-cap).toLocaleString()+" more</div>";
  return h+"</div>";
}
function loadPoints(){
  if(POINTS){draw();return;}
  q("cov").innerHTML="Loading establishments…";
  fetch("/api/points?v="+DATA_VERSION).then(function(r){return r.json();}).then(function(j){POINTS=j.items||[];draw();});
}
function covTract(){var nt=Object.keys(statByRegion).filter(function(k){return statByRegion[k].n>=FLOOR;}).length;
  q("cov").innerHTML="Census tracts shaded where &ge; "+FLOOR+" establishments fall inside ("+nt+" tracts).";}
function loadTract(){
  if(!regions)return;
  if(shadeMode==="resid"){   // aggregate per-establishment residual by tract, client-side
    var cu=q("cuisine").value, mu=cuMean(), agg={};
    (POINTS||[]).forEach(function(p){if(cu&&p.cu!==cu)return;if(p.t==null)return;var r=residP(p,mu);if(r==null)return;var a=agg[p.t]||(agg[p.t]={s:0,n:0});a.s+=r;a.n++;});
    statByRegion={};for(var t in agg)statByRegion[t]={n:agg[t].n,avg:agg[t].s/agg[t].n};
    covTract();render();
  }else{
    var cu2=q("cuisine").value,basis=q("basis").value;
    fetch("/api/region-stats?basis="+basis+(cu2?"&cuisine="+cu2:"")+"&v="+DATA_VERSION).then(function(r){return r.json();}).then(function(j){
      statByRegion={};(j.regions||[]).forEach(function(r){statByRegion[r.region_id]={n:r.n,avg:r.avg};});
      covTract();render();
    });
  }
}
function draw(){
  if(aggMode==="geohash"){if(gl){gl.remove();gl=null;}renderGeohash();}
  else{if(ghLayer){ghLayer.remove();ghLayer=null;}loadTract();}
}
function loadStats(){
  if((aggMode==="geohash"||shadeMode==="resid")&&!POINTS){loadPoints();return;}   // residual needs the raw points
  draw();
}
function applyMode(){
  var gh=aggMode==="geohash";
  q("desc").innerHTML=shadeMode==="resid"
    ?"Each area is shaded by its restaurants' mean <b>residual vs their own cuisine's norm</b> — green = collectively beating what their cuisines predict, red = trailing. This controls for each area's cuisine mix (so a Chinese-heavy area isn't penalized for Chinese being graded harder)."
    :(gh?"Establishments are binned into <b>geohash tiles</b> shaded by their mean rating (1 = Excellent … 4 = Needs to Improve; lower is better); tiles <b>subdivide as you zoom in</b>."
        :"Each census tract is shaded by the <b>plain mean</b> of its restaurants' ratings (1 = Excellent … 4 = Needs to Improve; lower is better).");
  if(gh){if(gl){gl.remove();gl=null;}}else{if(ghLayer){ghLayer.remove();ghLayer=null;}}
  loadStats();
}
function segWire(id,set){q(id).querySelectorAll("button").forEach(function(btn){btn.onclick=function(){
  if(btn.classList.contains("on"))return;set(btn.getAttribute("data-v"));
  q(id).querySelectorAll("button").forEach(function(b){b.classList.toggle("on",b===btn);});applyMode();};});}
segWire("aggby",function(v){aggMode=v;});
segWire("shadeby",function(v){shadeMode=v;});
q("cuisine").onchange=loadStats;q("basis").onchange=loadStats;
map.on("zoomend",function(){if(aggMode==="geohash"&&POINTS)renderGeohash();});
// load tract geometry in the background (only needed if the user switches to the tract view)
fetch("/regions.geojson?v="+DATA_VERSION).then(function(r){return r.json();}).then(function(g){regions=g;if(aggMode==="tract")loadStats();});
applyMode();   // initial draw in the default mode
// collapsible filters — start collapsed on phones so the map gets the screen; tap the header to toggle
if(window.matchMedia("(max-width:720px)").matches) q("panel").classList.add("collapsed");
q("head").onclick=function(e){if(e.target.closest("a"))return;   // let the "back" link navigate
  if(!window.matchMedia("(max-width:720px)").matches)return;   // collapse only on mobile
  q("panel").classList.toggle("collapsed");setTimeout(function(){map.invalidateSize();},210);};
</script><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "4038d69ec05f4dff86953ee46d95bcdd"}'></script></body></html>`;

// ============================ /bloopers — the funny reel ============================
// Curated absurd inspector narratives (Snohomish v_memo), classified at ingest.
const BLOOPERS_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ratings">
<link rel="apple-touch-icon" href="/icon-180.png?v=7">
<title>Sno/King Food Safety — Inspection Bloopers</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#2a3038;--accent:#58a6ff}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{padding:calc(22px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) 8px calc(20px + env(safe-area-inset-left));max-width:1100px;margin:0 auto}
  h1{font-size:24px;margin:0 0 2px}
  .sub{color:var(--muted);font-size:13px;margin:0} a{color:var(--accent);text-decoration:none}
  #tools{max-width:1100px;margin:10px auto 0;padding:0 20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  #q{flex:1;min-width:180px;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:#0d1117;color:var(--ink);font-size:14px}
  #count{color:var(--muted);font-size:13px}
  #grid{max-width:1100px;margin:14px auto 60px;padding:0 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:15px 16px;display:flex;flex-direction:column}
  .card .em{font-size:30px;line-height:1;margin-bottom:8px}
  .card .quote{font-size:15px;color:#eef3f8}
  .card .meta{margin-top:auto;padding-top:11px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);margin-top:12px}
  .card .meta b{color:var(--ink)} .card .vlabel{color:#6e7681;font-size:11.5px;margin-top:6px}
  .loading{color:var(--muted);padding:20px}
</style></head><body>
<header>
  <h1>😅 Inspection Bloopers</h1>
  <p class="sub">Real lines from food-inspection reports. <a href="/">← back to the map</a></p>
</header>
<div id="tools">
  <input id="q" placeholder="Search the bloopers…" autocomplete="off">
  <span id="count">…</span>
</div>
<div id="grid"><div class="loading">Loading the good stuff…</div></div>
<script>
var DATA_VERSION="__DATA_VERSION__";
var ALL=[],q="";
function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
function fmt(d){if(!d)return"";var x=new Date(d);return isNaN(x)?d:x.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});}
function card(b){
  return '<div class="card"><div class="em">'+(b.tag||"😅")+'</div>'+
    '<div class="quote">"'+esc(b.text)+'"</div>'+
    '<div class="vlabel">'+esc(b.label||"")+'</div>'+
    '<div class="meta">'+(b.city?esc(b.city):'Snohomish County')+(b.date?' · '+fmt(b.date):'')+'</div></div>';
}
function render(){
  var list=ALL.filter(function(b){return !q||((b.text+" "+(b.label||"")+" "+(b.city||"")).toLowerCase().indexOf(q)>=0);});
  document.getElementById("count").textContent=list.length.toLocaleString()+(q?" matching":"")+" bloopers";
  document.getElementById("grid").innerHTML=list.length?list.map(card).join(""):'<div class="loading">No matches.</div>';
}
fetch("/api/bloopers?v="+DATA_VERSION).then(function(r){return r.json();}).then(function(j){
  ALL=(j.items||[]);
  // fresh random order on every load — the reel is for browsing, not chronology, and the API
  // response is edge-cached in one fixed order, so the shuffle has to happen here on the client
  for(var i=ALL.length-1;i>0;i--){var k=Math.floor(Math.random()*(i+1)),tmp=ALL[i];ALL[i]=ALL[k];ALL[k]=tmp;}
  render();
});
var t;document.getElementById("q").oninput=function(e){clearTimeout(t);var v=e.target.value.toLowerCase();t=setTimeout(function(){q=v;render();},160);};
</script><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "4038d69ec05f4dff86953ee46d95bcdd"}'></script></body></html>`;

// ============================ /about — methodology ============================
const ABOUT_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<link rel="apple-touch-icon" href="/icon-180.png?v=7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ratings">
<title>About — Sno/King Food Safety</title>
<style>
  :root{--bg:#0d1117;--ink:#e6edf3;--muted:#8b949e;--line:#2a3038;--accent:#58a6ff}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.62 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:var(--accent)}
  .wrap{max-width:740px;margin:0 auto;padding:calc(24px + env(safe-area-inset-top)) calc(22px + env(safe-area-inset-right)) 64px calc(22px + env(safe-area-inset-left))}
  .back{display:inline-block;color:var(--muted);text-decoration:none;font-size:14px;margin-bottom:16px}
  .back:hover{color:var(--accent)}
  h1{font-size:27px;margin:0 0 14px;letter-spacing:-.01em}
  h2{font-size:19px;margin:34px 0 8px;font-weight:600}
  p{margin:0 0 14px;color:#c9d2dc}
  ul{margin:0 0 14px;padding-left:22px;color:#c9d2dc}
  li{margin:5px 0}
  strong{color:var(--ink);font-weight:600}
  table{border-collapse:collapse;margin:8px 0 16px;font-size:15px}
  th,td{border:1px solid var(--line);padding:6px 16px;text-align:left}
  th{color:var(--muted);font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.03em}
</style></head><body>
<div class="wrap">
  <a class="back" href="/">&larr; back to the map</a>
  <h1>About this map</h1>

  <p>This is a map of restaurant and food-establishment inspection ratings for King and Snohomish counties. The inspection records are already public, but they're spread across two county systems and aren't easy to browse or compare. This puts both counties on one map, lets you filter and sort it, and makes it possible to see patterns that aren't obvious when you look up one place at a time.</p>

  <h2>Where the data comes from</h2>
  <ul>
    <li><strong>King County:</strong> restaurant inspection records published by Public Health &mdash; Seattle &amp; King County.</li>
    <li><strong>Snohomish County:</strong> inspection records from the Snohomish County Health Department.</li>
  </ul>
  <p>Both are public inspection records. The map refreshes from those sources on a regular schedule, so ratings update as new inspections are posted.</p>

  <h2>How the rating works</h2>
  <p>Every establishment is placed on the same four labels &mdash; Excellent, Good, Okay, Needs to Improve (lower is better) &mdash; but the two counties produce them differently.</p>
  <p><strong>King County</strong> publishes its own rating, and this map uses it as-is. King calculates it from the average of a restaurant's <em>critical</em> (red) violation points across its last four routine inspections, with the cutoffs between categories set relative to how all King County restaurants score, plus rules for recent closures and repeat re-inspections. King's full methodology is published <a href="https://kingcounty.gov/en/dept/dph/health-safety/food-safety/inspection-rating-system/rating-system" target="_blank" rel="noopener">here</a>.</p>
  <p><strong>Snohomish County</strong> doesn't publish a summary rating, so this map derives one &mdash; but to make it directly comparable to King's, it mirrors King's method exactly. Both counties inspect against the same Washington State Retail Food Code, which classifies every violation as <em>critical</em> (major) or non-critical (minor) with a point value. So for each Snohomish establishment we count only the critical violation points, average them over its recent routine inspections, and apply the same category cutoffs King's own grades fall on. King averages more inspections for higher-risk places, so we do too: the last four routine inspections for higher-risk establishments (full-service restaurants) and the last two for lower-risk ones (coffee stands, markets, and the like). The grade you see is computed the same way on both sides of the county line.</p>
  <p>Because the grade is an average of recent critical-violation points, "Excellent" means consistently very low critical points &mdash; not necessarily a spotless single visit.</p>

  <h2>Ways to explore it</h2>
  <p>You can filter the map by cuisine and shade it by different measures, including:</p>
  <ul>
    <li>the latest inspection rating</li>
    <li>the most recent <strong>routine</strong> inspection, ignoring follow-up re-inspections</li>
    <li>the average of the last five inspections</li>
    <li>the worst rating on record</li>
    <li>how often a place's routine inspections come back okay-or-worse</li>
    <li>years on record</li>
    <li>cuisine type</li>
  </ul>
  <p>There's also a stats view that aggregates ratings by area, either by census tract or by map tiles that get smaller as you zoom in.</p>
  <p>The history-based measures (average, worst on record, how often routines come back poor) are calculated the same way from raw inspection points in both counties, so they're the most directly comparable views across the county line.</p>

  <h2>Comparing restaurants of the same cuisine</h2>
  <p>One pattern stands out in the data: inspection scores track closely with the kind of food a place makes. Restaurants that cook a lot from scratch &mdash; handling raw ingredients, holding food hot and cold, and doing more steps by hand &mdash; tend to accumulate more violation points than places like coffee shops, bakeries, and bars.</p>
  <p>This isn't a statement about cleanliness. A kitchen doing complex prep simply has more points where an inspector can find something, so it carries more risk on paper than a place that mostly pours drinks or sells pre-made items. Comparing those two on raw score isn't a fair comparison.</p>
  <p>Because of that, the map has a <strong>"vs cuisine norm"</strong> view. Instead of coloring each place by its absolute rating, it colors each place by how it compares to the average for its own cuisine. A chicken restaurant that does better than most chicken restaurants shows up as strong, even if its raw score is middling for the map as a whole. This is the most useful way to read the data if you want to know which restaurants stand out among their peers, rather than which cuisines are harder to inspect.</p>

  <h2>What the ratings don't tell you</h2>
  <p>An inspection is a snapshot of one visit. The result depends on timing and on the inspector, and many violations are about record-keeping or signage rather than anything you'd notice as a customer. A single good score doesn't guarantee a good experience, and one bad inspection doesn't mean a place is unsafe. The history-based measures are steadier than any single rating, which is why they're included.</p>
  <p>Snohomish County's online records only go back a few years, so "years on record" and long-term history are shorter there than in King County.</p>

  <h2>Not an official source</h2>
  <p>This is an independent project. It isn't affiliated with, operated by, or endorsed by King County, Snohomish County, or any health department. The data is pulled from county records and processed automatically, so some details may be off, such as a misplaced pin or a cuisine guessed incorrectly. For authoritative inspection information, or to correct a restaurant's record, check with the county directly:</p>
  <ul>
    <li>King County: <a href="https://kingcounty.gov/en/dept/dph/health-safety/food-safety/search-restaurant-safety-ratings" target="_blank" rel="noopener">food safety ratings lookup</a></li>
    <li>Snohomish County: <a href="https://www.snohd.org/169/Food-Safety-Program" target="_blank" rel="noopener">Snohomish County Health Department &mdash; Food Safety Program</a></li>
  </ul>

  <h2>Source code</h2>
  <p>The whole thing is open source: <a href="https://github.com/swannman/snoking-foodsafety" target="_blank" rel="noopener">github.com/swannman/snoking-foodsafety</a>. That includes the ingester that pulls both counties and the exact scoring code described above, so if you want to check how a rating was arrived at, you can read it rather than take my word for it.</p>

  <h2>Credits</h2>
  <p><strong>Inspection data:</strong> Public Health &mdash; Seattle &amp; King County, and the Snohomish County Health Department.</p>
  <p><strong>Map tiles:</strong> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, and Esri &mdash; Esri, HERE, Garmin, and the GIS user community (neighborhood-trends map). Demographic context on the trends map is from the U.S. Census Bureau&rsquo;s American Community Survey.</p>
</div><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "4038d69ec05f4dff86953ee46d95bcdd"}'></script></body></html>`;

// ============================ /dashboard — token-gated analytics ============================
const DASH_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sno/King — Dashboard</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#283039;--accent:#58a6ff}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
  header h1{font-size:16px;margin:0;flex:1}
  header a{color:var(--muted);text-decoration:none;font-size:12px}
  select,button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:6px 10px;font-size:13px;cursor:pointer}
  #refresh{padding:8px 16px;font-size:15px;font-weight:600;background:var(--accent);color:#0d1117;border-color:var(--accent)}
  main{max-width:1400px;margin:0 auto;padding:16px 24px 60px}
  #openRestK .lbl,#openRestS .lbl{width:auto;flex:1;max-width:62%}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:8px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .tile .n{font-size:24px;font-weight:700;letter-spacing:-.02em}
  .tile .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px;margin-top:14px}
  section h2{font-size:12px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
  @media(max-width:640px){.cols{grid-template-columns:1fr}}
  .row{display:flex;align-items:center;gap:9px;margin:5px 0;font-size:12.5px}
  .row .lbl{width:118px;flex:none;color:#c9d2dc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* instant custom tooltip (the native title attribute has a ~1s browser delay) */
  [data-tip]{position:relative}
  [data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 5px);background:#0b0f14;color:#e6edf3;border:1px solid var(--line);padding:5px 8px;border-radius:6px;font-size:11.5px;line-height:1.35;z-index:30;box-shadow:0 6px 18px rgba(0,0,0,.55);pointer-events:none}
  .row[data-tip]{cursor:help}
  .row[data-tip] .lbl{text-decoration:underline dotted #4a5563;text-underline-offset:2px}
  .row[data-tip]:hover::after{left:0;white-space:normal;max-width:300px;width:max-content}
  .spark .b[data-tip]:hover::after{left:50%;transform:translateX(-50%);white-space:nowrap}
  .wide .row .lbl{width:auto;flex:1;max-width:62%}
  .axis{display:flex;gap:2px;margin-top:3px}
  .axis .t{flex:1;min-width:2px;font-size:9px;color:var(--muted);text-align:center;white-space:nowrap;overflow:visible}
  .row .bar{flex:1;height:15px;background:#0d1117;border-radius:4px;overflow:hidden}
  .row .bar i{display:block;height:100%;background:var(--accent);border-radius:4px}
  .row .val{width:54px;flex:none;text-align:right;color:#c9d2dc;font-variant-numeric:tabular-nums}
  .row .rdot{width:9px;height:9px;border-radius:50%;flex:none;margin-right:7px}
  .row .city{color:var(--muted);font-size:11px;margin-left:5px}
  a.rowlink{text-decoration:none;color:inherit}
  a.rowlink:hover .lbl{color:var(--accent)}
  a.rowlink:hover{cursor:pointer}
  .spark{display:flex;align-items:flex-end;gap:2px;height:90px}
  .spark .b{flex:1;min-width:2px;background:var(--accent);border-radius:2px 2px 0 0;opacity:.85}
  .spark .b:hover{opacity:1}
  .chartwrap{display:flex;gap:7px;margin-top:6px}
  .chartcol{flex:1;min-width:0}
  .yaxis{display:flex;flex-direction:column;justify-content:space-between;height:90px;font-size:9px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
  .yaxis.yr{text-align:left}
  .muted{color:var(--muted);font-size:12px}
  #gate{max-width:360px;margin:60px auto;text-align:center}
  #gate input{width:100%;margin:12px 0;padding:9px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font-size:14px}
</style></head><body>
<header>
  <h1>Sno/King Analytics</h1>
  <a href="/">← map</a>
  <select id="days"><option value="1">Today</option><option value="2">2 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="90">90 days</option></select>
  <button id="refresh" title="Refresh">Refresh</button>
</header>
<div id="gate" hidden>
  <h2>Enter dashboard token</h2>
  <input id="tok" type="password" placeholder="dashboard token" autocomplete="off">
  <button id="save">Open dashboard</button>
  <p class="muted" id="gerr"></p>
</div>
<main id="app" hidden>
  <div class="tiles" id="tiles"></div>
  <section><h2>Sessions &amp; opens per day <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">(Pacific)</span></h2><div id="daily"></div></section>
  <section><h2>Top referrers</h2><div id="referrers"></div></section>
  <section><h2>Link tags / campaigns <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">(?ref= or utm_)</span></h2><div id="src"></div></section>
  <div class="cols">
    <section><h2>Shade-by views</h2><div id="shade"></div></section>
    <section><h2>Cuisine filters</h2><div id="cuisine"></div></section>
  </div>
  <div class="cols">
    <section><h2>Most-checked &mdash; King County</h2><div id="openRestK"></div></section>
    <section><h2>Most-checked &mdash; Snohomish County</h2><div id="openRestS"></div></section>
  </div>
  <section class="wide"><h2>Most-saved restaurants</h2><div id="savedRest"></div></section>
  <div class="cols">
    <section><h2>Opens by cuisine</h2><div id="openCuisine"></div></section>
    <section><h2>Opens by county</h2><div id="county"></div></section>
  </div>
  <section><h2>Event types</h2><div id="byType"></div></section>
  <section><h2>Last 48h &mdash; sessions per hour (local)</h2><div id="hourly"></div></section>
  <p class="muted" id="foot"></p>
</main>
<script>
(function(){
  var KEY="snoking_dash_tok";
  var gate=document.getElementById("gate"),app=document.getElementById("app");
  function tok(){return localStorage.getItem(KEY)||"";}
  function showGate(msg){gate.hidden=false;app.hidden=true;document.getElementById("gerr").textContent=msg||"";}
  function n(x){return parseInt(x,10)||0;}
  function fmt(x){return n(x).toLocaleString();}
  function clab(k){return k==="k"?"King":k==="s"?"Snohomish":(k||"(none)");}
  var SHADE_LABELS={rating:"Rating — latest inspection",routine:"Last routine rating (ignores reinspections)",avg:"Average of the last 5 inspections",worstpts:"Worst inspection on record (violation points)",poorfrac:"% of routines that came back Okay-or-worse (chronic)",resid:"vs cuisine norm — over/under-performers vs same cuisine",changed:"Recently changed — new + rating up/down",age:"Years in operation",cuisine:"Shaded by cuisine type"};
  var EVENT_LABELS={open:"Opened a restaurant card",app:"App load (session start)",hist:"Expanded an inspection-history date",shade:"Changed the shade-by metric",search:"Used the name/address search",filter:"Changed the cuisine filter",fav:"Saved/unsaved a favorite",alerts:"Enabled/disabled push alerts",about:"Opened the About page",stats:"Opened the per-capita / stats map",bloopers:"Opened the bloopers reel",locate:"Tapped Zoom-to-my-location",install:"Installed the PWA (Add to Home Screen)",nav:"Opened Stats / Bloopers / About (legacy event)"};
  function barList(elId,rows,labelFn,titleMap){
    var el=document.getElementById(elId);
    if(!rows||!rows.length){el.innerHTML='<p class="muted">no data yet</p>';return;}
    var max=0;rows.forEach(function(r){if(n(r.v)>max)max=n(r.v);});max=max||1;
    var h="";rows.forEach(function(r){var v=n(r.v),pct=Math.round(v/max*100),lab=labelFn?labelFn(r.k):(r.k||"(none)");
      var ttl=titleMap===true?lab:(titleMap?(titleMap[r.k]||r.k):"");   // fall back to the raw key so every labeled row has a tooltip
      h+='<div class="row"'+(ttl?' data-tip="'+esc(ttl)+'"':'')+'><span class="lbl">'+esc(lab)+'</span><span class="bar"><i style="width:'+pct+'%"></i></span><span class="val">'+fmt(v)+'</span></div>';});
    el.innerHTML=h;
  }
  var RCOLOR={1:"#2ecc71",2:"#a8c800",3:"#f0a020",4:"#e5484d"},RLAB={1:"Excellent",2:"Good",3:"Okay",4:"Needs Improve"};
  // restaurant list with a rating swatch + city, so you can see whether high- or low-rated places get checked
  function ratedList(elId,rows){
    var el=document.getElementById(elId);
    if(!rows||!rows.length){el.innerHTML='<p class="muted">no data yet</p>';return;}
    var max=0;rows.forEach(function(r){if(n(r.v)>max)max=n(r.v);});max=max||1;
    var h="";rows.forEach(function(r){var v=n(r.v),pct=Math.round(v/max*100),rt=r.rating,city=r.city?r.city.replace(/\b\w/g,function(c){return c.toUpperCase();}):"";
      var tip=(rt?RLAB[rt]:"Unrated")+(city?" · "+city:"")+" — "+r.k+(r.id?" (open on map)":"");
      var tag=r.id?'a href="/?focus='+encodeURIComponent(r.id)+'" target="_blank" rel="noopener" class="row rowlink"':'div class="row"';
      h+='<'+tag+' data-tip="'+esc(tip)+'"><span class="rdot" style="background:'+(RCOLOR[rt]||"#7d8590")+'"></span><span class="lbl">'+esc(r.k)+(city?' <span class="city">'+esc(city)+'</span>':"")+'</span><span class="bar"><i style="width:'+pct+'%"></i></span><span class="val">'+fmt(v)+'</span></'+(r.id?"a":"div")+'>';});
    el.innerHTML=h;
  }
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];});}
  function renderDaily(rows){
    var el=document.getElementById("daily");
    if(!rows||!rows.length){el.innerHTML='<p class="muted">no data yet</p>';return;}
    var max=0;rows.forEach(function(r){if(n(r.sessions)>max)max=n(r.sessions);});max=max||1;
    var h="";rows.forEach(function(r){var s=n(r.sessions),pct=Math.round(s/max*100),d=String(r.k).slice(5).replace("-","/");
      h+='<div class="row"><span class="lbl">'+d+'</span><span class="bar"><i style="width:'+pct+'%"></i></span><span class="val">'+fmt(s)+'</span></div>';});
    el.innerHTML=h;
  }
  function renderHourly(rows){
    var el=document.getElementById("hourly");
    if(!rows||!rows.length){el.innerHTML='<p class="muted">no data yet</p>';return;}
    var max=0;rows.forEach(function(r){if(n(r.sessions)>max)max=n(r.sessions);});max=max||1;
    var bars="",axis="";rows.forEach(function(r){var s=n(r.sessions),ht=Math.max(2,Math.round(s/max*100)),dt=new Date(r.k.replace(" ","T")+"Z");
      var tip=dt.toLocaleString([], {weekday:"short",hour:"numeric"})+": "+s+" sessions";
      bars+='<span class="b" data-tip="'+esc(tip)+'" style="height:'+ht+'%"></span>';
      var hr=dt.getHours();   // sparse x-axis ticks: date at local midnight, am/pm markers at 6/12/18
      var t=hr===0?dt.toLocaleDateString([], {month:"numeric",day:"numeric"}):(hr===6?"6a":(hr===12?"12p":(hr===18?"6p":"")));
      axis+='<span class="t">'+t+'</span>';});
    var yax='<span>'+max+'</span><span>'+Math.round(max/2)+'</span><span>0</span>';   // sessions scale (both sides)
    el.innerHTML='<div class="chartwrap"><div class="yaxis">'+yax+'</div><div class="chartcol"><div class="spark">'+bars+'</div><div class="axis">'+axis+'</div></div><div class="yaxis yr">'+yax+'</div></div>';
  }
  function tiles(d){
    var sess=0,opens=0,events=0,inst=0;
    (d.daily||[]).forEach(function(r){sess+=n(r.sessions);opens+=n(r.opens);events+=n(r.events);});
    (d.install||[]).forEach(function(r){if(r.k==="installed")inst+=n(r.v);});
    var ops=sess?(opens/sess).toFixed(1):"0";
    var t=[["Sessions",fmt(sess)],["Card opens",fmt(opens)],["Opens / session",ops],["PWA installs",fmt(inst)],["Total events",fmt(events)]];
    var h="";t.forEach(function(x){h+='<div class="tile"><div class="n">'+x[1]+'</div><div class="l">'+x[0]+'</div></div>';});
    document.getElementById("tiles").innerHTML=h;
  }
  function load(){
    var days=document.getElementById("days").value;
    fetch("/dash/data?days="+days,{headers:{Authorization:"Bearer "+tok()}}).then(function(r){
      if(r.status===401){localStorage.removeItem(KEY);showGate("Invalid token.");throw new Error("401");}
      return r.json();
    }).then(function(d){
      gate.hidden=true;app.hidden=false;
      tiles(d);renderDaily(d.daily);renderHourly(d.hourly);
      barList("referrers",d.referrers);barList("src",d.src);barList("shade",d.shade,null,SHADE_LABELS);barList("cuisine",d.cuisine);
      barList("county",d.county,clab);barList("byType",d.byType,null,EVENT_LABELS);
      ratedList("openRestK",d.openRestK);ratedList("openRestS",d.openRestS);ratedList("savedRest",d.savedRest);barList("openCuisine",d.openCuisine);
      document.getElementById("foot").textContent="Counts are sampling-estimated. Updated "+new Date().toLocaleString();
    }).catch(function(){});
  }
  document.getElementById("save").onclick=function(){var v=document.getElementById("tok").value.trim();if(!v)return;localStorage.setItem(KEY,v);load();};
  document.getElementById("tok").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("save").click();});
  document.getElementById("refresh").onclick=load;
  document.getElementById("days").onchange=load;
  if(tok())load();else showGate("");
  // auto-refresh every 60s while the tab is open (skip when hidden or not signed in)
  setInterval(function(){if(tok()&&document.visibilityState==="visible")load();},60000);
})();
</script>
</body></html>`;
