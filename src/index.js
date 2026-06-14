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

const RATING_LABEL = { 1: "Excellent", 2: "Good", 3: "Okay", 4: "Needs to Improve" };
// per-inspection rating from its violation points (lower=better); shared by both counties
const pointRating = (p) => (p == null || isNaN(p) ? null : p <= 0 ? 1 : p <= 15 ? 2 : p <= 35 ? 3 : 4);
// mean rating over the most recent N inspections (history is newest-first)
function avgRating(history, n = 5) {
  const rs = (history || []).map((h) => pointRating(h.score)).filter((r) => r != null).slice(0, n);
  return rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
}
const isRoutine = (s) => /routine/i.test(s || "");
function ratingRoutineOf(h) { for (const x of h || []) if (isRoutine(x.svc)) { const r = pointRating(x.score); if (r != null) return r; } return null; }
function ratingWorstOf(h) { let w = null; for (const x of h || []) { const r = pointRating(x.score); if (r != null && (w == null || r > w)) w = r; } return w; }
function poorFracOf(h) { const s = (h || []).filter((x) => isRoutine(x.svc) && pointRating(x.score) != null); return s.length ? Math.round((s.filter((x) => pointRating(x.score) >= 3).length / s.length) * 1000) / 1000 : null; }
function worstPointsOf(h) { let w = null; for (const x of h || []) if (x.score != null && (w == null || x.score > w)) w = x.score; return w; }

// Read endpoints are immutable per data version (client appends ?v=<updated_at>), so they're
// safe to store in Cloudflare's edge cache. Without this every unique visitor re-runs the
// full-table scans against D1; with it, the Worker touches D1 only on the first request per
// version per colo — repeat & shared traffic is served from cache for ~0 D1 rows read.
const CACHEABLE = new Set(["/api/establishments", "/api/points", "/api/region-stats", "/api/stats", "/api/bloopers", "/regions.geojson"]);
// Service worker (network-first, cache fallback) so the installed PWA loads offline. Always fresh
// online; serves the last-seen page/assets/tiles when there's no network.
const SW_JS = `const C="snoking-v1";
self.addEventListener("install",function(e){self.skipWaiting();});
self.addEventListener("activate",function(e){e.waitUntil((async function(){var ks=await caches.keys();await Promise.all(ks.filter(function(k){return k!==C;}).map(function(k){return caches.delete(k);}));await self.clients.claim();})());});
self.addEventListener("fetch",function(e){var r=e.request;if(r.method!=="GET")return;
  e.respondWith((async function(){
    try{var res=await fetch(r);
      if(res&&res.status===200&&(new URL(r.url).origin===location.origin||/unpkg\\.com|cartocdn\\.com|tile\\.openstreetmap/.test(r.url))){var c=res.clone();caches.open(C).then(function(ca){ca.put(r,c);});}
      return res;
    }catch(err){var m=await caches.match(r);if(m)return m;throw err;}
  })());
});`;
function cachePut(req, ctx, resp) {
  try { if (resp && resp.ok && ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(req, resp.clone())); } catch {}
  return resp;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "GET" && CACHEABLE.has(url.pathname)) {
      const hit = await caches.default.match(req).catch(() => null);
      if (hit) return hit;
    }

    // ── PWA: manifest, icons (from KV), service worker ──────────────────────────
    if (url.pathname === "/manifest.webmanifest") {
      return Response.json({
        name: "SnoKing Food Safety", short_name: "Ratings",
        description: "Restaurant food-safety inspection ratings map for King & Snohomish counties, WA",
        start_url: "/", scope: "/", display: "standalone", orientation: "any",
        background_color: "#0d1117", theme_color: "#0d1117",
        icons: [
          { src: "/icon-192.png?v=7", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png?v=7", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png?v=7", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }, { headers: { "Cache-Control": "public, max-age=86400" } });
    }
    if (/^\/icon-\d+\.png$/.test(url.pathname)) {
      const buf = await env.REGIONS.get(url.pathname.slice(1), { type: "arrayBuffer" });
      return buf ? new Response(buf, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } })
                 : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/sw.js") {
      return new Response(SW_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    if (url.pathname === "/ingest" && req.method === "POST") {
      if ((req.headers.get("Authorization") || "") !== "Bearer " + env.INGEST_TOKEN)
        return new Response("unauthorized", { status: 401 });
      let recs;
      try { recs = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(recs)) return new Response("expected array", { status: 400 });
      const now = new Date().toISOString();
      const stmts = recs.slice(0, 1000).map((r) =>
        env.DB.prepare(
          `INSERT INTO establishments
             (id,county,name,address,city,zip,lat,lon,cuisine,rating,rating_label,grade,score,result,inspect_date,first_date,report_url,detail,rating_avg,rating_avg_all,rating_routine,rating_worst,poor_frac,worst_points,tract_id,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             county=excluded.county, name=excluded.name, address=excluded.address, city=excluded.city,
             zip=excluded.zip, lat=excluded.lat, lon=excluded.lon, cuisine=excluded.cuisine, rating=excluded.rating,
             rating_label=excluded.rating_label, grade=excluded.grade, score=excluded.score, result=excluded.result,
             inspect_date=excluded.inspect_date, first_date=excluded.first_date, report_url=excluded.report_url,
             detail=excluded.detail, rating_avg=excluded.rating_avg, rating_avg_all=excluded.rating_avg_all,
             rating_routine=excluded.rating_routine, rating_worst=excluded.rating_worst, poor_frac=excluded.poor_frac, worst_points=excluded.worst_points, tract_id=excluded.tract_id, updated_at=excluded.updated_at`
        ).bind(
          r.id, r.county, r.name, r.address ?? null, r.city ?? null, r.zip ?? null, r.lat ?? null, r.lon ?? null,
          r.cuisine ?? null, r.rating ?? null, r.rating != null ? RATING_LABEL[r.rating] ?? null : null,
          r.grade ?? null, r.score ?? null, r.result ?? null, r.inspect_date ?? null, r.first_date ?? null,
          r.report_url ?? null, typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail ?? {}),
          r.rating_avg ?? avgRating((typeof r.detail === "object" ? r.detail : {}).history),
          r.rating_avg_all ?? avgRating((typeof r.detail === "object" ? r.detail : {}).history, 99),
          r.rating_routine ?? r.rating ?? null, r.rating_worst ?? r.rating ?? null, r.poor_frac ?? null, r.worst_points ?? null, r.tract_id ?? null, now
        )
      );
      for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25));
      return Response.json({ ok: true, n: stmts.length });
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
      const { results } = await env.DB.prepare("SELECT id,name,city,date,tag,label,text,report_url,lat,lon FROM bloopers ORDER BY date DESC").all();
      return cachePut(req, ctx, Response.json({ count: (results || []).length, items: results || [] }, { headers: { "Cache-Control": "public, max-age=900" } }));
    }
    if (url.pathname === "/bloopers") return new Response(BLOOPERS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });

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

    if (url.pathname === "/api/establishments") {
      const { results } = await env.DB.prepare(
        `SELECT id,county,name,address,city,zip,lat,lon,cuisine,rating,rating_avg,rating_routine,rating_worst,poor_frac,worst_points,grade,score,result,inspect_date,first_date
         FROM establishments WHERE lat IS NOT NULL AND lon IS NOT NULL`
      ).all();
      const items = (results || []).map((r) => ({
        id: r.id, co: r.county === "king" ? "k" : "s", n: r.name, a: r.address, ci: r.city, z: r.zip,
        la: r.lat, lo: r.lon, cu: r.cuisine, r: r.rating, ra: r.rating_avg, rr: r.rating_routine, rw: r.rating_worst, pf: r.poor_frac, wp: r.worst_points,
        g: r.grade, s: r.score, rs: r.result, d: r.inspect_date, fd: r.first_date,
      }));
      const upd = await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first();
      return cachePut(req, ctx, Response.json({ updated: upd?.u ?? null, count: items.length, items }, {
        headers: { "Cache-Control": "public, max-age=86400" },   // safe: client requests ?v=<updated_at>
      }));
    }

    if (url.pathname === "/api/points") {
      // minimal points for client-side geohash-tile aggregation on /stats (la,lo,cuisine + the
      // three rating bases). Tiny payload; client requests ?v=<updated_at> so it caches hard.
      const { results } = await env.DB.prepare(
        `SELECT name,lat,lon,cuisine,rating,rating_avg,rating_avg_all,tract_id
         FROM establishments WHERE lat IS NOT NULL AND lon IS NOT NULL`
      ).all();
      const items = (results || []).map((r) => ({ n: r.name, la: r.lat, lo: r.lon, cu: r.cuisine, r: r.rating, ra: r.rating_avg, aa: r.rating_avg_all, t: r.tract_id }));
      const upd = await env.DB.prepare("SELECT MAX(updated_at) AS u FROM establishments").first();
      return cachePut(req, ctx, Response.json({ updated: upd?.u ?? null, items }, { headers: { "Cache-Control": "public, max-age=86400" } }));
    }

    if (url.pathname === "/api/detail") {
      const id = url.searchParams.get("id");
      const row = await env.DB.prepare(
        "SELECT id,name,report_url,detail FROM establishments WHERE id = ?"
      ).bind(id).first();
      if (!row) return new Response("not found", { status: 404 });
      let detail = {}; try { detail = JSON.parse(row.detail || "{}"); } catch {}
      return Response.json({ id: row.id, name: row.name, report_url: row.report_url, ...detail });
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
      const html = MAP_HTML.replace("__DATA_VERSION__", encodeURIComponent(v));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    return new Response("not found", { status: 404 });
  },
};

const MAP_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SnoKing Food Safety — Restaurant Inspection Ratings</title>
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
  h1 .tog{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:#fff;background:var(--accent);padding:6px 12px;border-radius:999px;line-height:1}
  @media(min-width:721px){h1 .tog{display:none}}   /* panel is always open on desktop — no toggle needed */
  h1 .tog b{font-size:16px;line-height:1;transition:transform .15s;display:inline-block}
  #feed:not(.collapsed) h1 .tog b{transform:rotate(180deg)}
  #feed.collapsed #controls,#feed.collapsed #listhead,#feed.collapsed #list{display:none}
  #feed.collapsed{height:auto;min-height:0}
  .sub{color:var(--muted);font-size:11.5px;margin:3px 0 0}
  #controls{padding:10px 16px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--panel2)}
  #q{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:#0d1117;color:var(--ink);font-size:13px}
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
  .chips{display:flex;gap:6px;margin-top:6px}
  .chip{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 4px;border:1px solid var(--line);border-radius:7px;background:#0d1117;cursor:pointer;font-size:11.5px;user-select:none}
  .chip.off{opacity:.4}
  .chip .sw{width:10px;height:10px;border-radius:50%}
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
  .pp-badge{display:inline-block;color:#fff;font-weight:600;font-size:11px;padding:2px 8px;border-radius:999px;margin:3px 0}
  .pp-addr{color:#555;font-size:12px}
  .pp-meta{color:#333;font-size:12px;margin-top:4px}
  .pp-meta b{color:#111}
  .sv{width:100%;height:130px;object-fit:cover;border-radius:6px;display:block;margin-bottom:7px;cursor:pointer;background:#eee}
  .pp-sec{margin-top:8px;border-top:1px solid #e3e3e3;padding-top:6px}
  .pp-sec h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#888}
  .viol{font-size:11.5px;margin-bottom:5px}
  .viol .vh{font-weight:600;color:#222}
  .viol .vt{display:inline-block;font-size:9.5px;font-weight:700;color:#fff;padding:1px 5px;border-radius:4px;margin-right:5px;vertical-align:1px}
  .viol .note{color:#555;white-space:pre-wrap;font-size:11px;margin-top:1px;max-height:60px;overflow:auto}
  .hist{font-size:11px;color:#444;display:flex;justify-content:space-between;border-top:1px dotted #ddd;padding:2px 0}
  .pp-link{display:inline-block;margin-top:7px;font-size:11.5px;color:#0969da;text-decoration:none;font-weight:600}
  .loading{color:#999;font-size:11.5px}
  @media (max-width:720px){
    #wrap{display:block;position:relative}
    #map{position:absolute;inset:0;height:100%;width:100%}
    /* filter panel becomes a scrollable overlay over a full-screen map, so all
       controls are reachable (no fixed-height clipping) */
    #feed{position:absolute;top:0;left:0;right:0;z-index:1000;width:auto;min-width:0;max-height:90vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-right:0;border-bottom:1px solid var(--line);box-shadow:0 10px 28px rgba(0,0,0,.45)}
    #feed.collapsed{max-height:none;overflow:visible;box-shadow:none}
    #list{flex:none}
    #legend{left:14px;bottom:14px;z-index:500}
    /* move zoom buttons clear of the header overlay (top) and legend (bottom-left) */
    .leaflet-top.leaflet-left{top:auto;left:auto;bottom:12px;right:12px}
  }
</style></head><body>
<div id="wrap">
  <div id="feed">
    <div id="head">
      <h1>SnoKing Food Safety <a class="statslink" href="/stats" title="Ratings by area" aria-label="Stats">📊</a> <a class="statslink" href="/bloopers" title="Inspection bloopers" aria-label="Bloopers">😅</a> <span class="statslink" id="loc" role="button" title="Show my location" aria-label="My location"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M21 3 3 10.53l7.61 2.86L13.47 21 21 3z"/></svg></span> <span class="tog" id="tog" title="Show/hide filters">Filters <b>▾</b></span></h1>
    </div>
    <div id="controls">
      <input id="q" placeholder="Search name or address…" autocomplete="off">
      <div class="field">
        <label>Cuisine</label>
        <select id="cuisine"><option value="">All cuisines</option></select>
      </div>
      <div class="field" id="rfield">
        <label><span id="rlabel">Rating</span> <span class="vals" id="rval"></span></label>
        <div class="dual" id="rslider"></div>
      </div>
      <div class="field">
        <label>Shade by <span class="vals" id="emojihint" style="font-weight:400;color:var(--muted)"></span></label>
        <select id="colorby">
          <option value="rating">Rating (latest)</option>
          <option value="avg">Avg of last 5 inspections</option>
          <option value="routine">Last routine (ignores reinspections)</option>
          <option value="worstpts">Worst inspection (points)</option>
          <option value="poorfrac">% routines Okay-or-worse (chronic)</option>
          <option value="resid">vs cuisine norm (over/under-performers)</option>
          <option value="age">Years in operation</option>
          <option value="cuisine">Cuisine</option>
        </select>
      </div>
    </div>
    <div id="listhead"><span id="count">…</span><span><span id="upd"></span> · in view · <span id="sortdir" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px" title="Click to flip sort order">worst first</span></span></div>
    <div id="list"></div>
  </div>
  <div id="map"></div>
  <div id="legend"></div>
</div>
<script>
var DATA_VERSION="__DATA_VERSION__";
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
var colorMode="rating", sortDir=1;   // sortDir: 1 = worst first (desc), -1 = best first (asc)
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
var RD_STOPS=[[-1.3,[176,42,42]],[-0.5,[224,138,90]],[0,[150,156,164]],[0.5,[143,196,106]],[1.3,[31,150,79]]];   // worse … neutral … better
function residColorAt(v){if(v==null)return"#555";v=Math.max(-1.3,Math.min(1.3,v));
  for(var i=0;i<RD_STOPS.length-1;i++){var a=RD_STOPS[i],b=RD_STOPS[i+1];if(v<=b[0]){var t=(v-a[0])/((b[0]-a[0])||1);
    return"rgb("+Math.round(a[1][0]+(b[1][0]-a[1][0])*t)+","+Math.round(a[1][1]+(b[1][1]-a[1][1])*t)+","+Math.round(a[1][2]+(b[1][2]-a[1][2])*t)+")";}}
  return"rgb(31,150,79)";}
function residColor(d){return residColorAt(residOf(d));}
function colorOf(d){if(colorMode==="cuisine")return CU_COLOR[cuGroup(d.cu)]||"#555";if(colorMode==="age")return ageColor(d);if(colorMode==="avg")return avgColor(d);
  if(colorMode==="routine")return COLOR[d.rr==null?0:d.rr];if(colorMode==="worstpts")return wpColor(d);if(colorMode==="poorfrac")return pfColor(d);if(colorMode==="resid")return residColor(d);return COLOR[ratingOf(d)];}
function renderLegend(){
  var el=document.getElementById("legend"),h="";
  if(colorMode==="rating"||colorMode==="routine"){h='<h4>'+(colorMode==="routine"?"Last routine rating":"Rating")+'</h4>';[1,2,3,4,0].forEach(function(r){h+='<div class="lg"><span class="sw" style="background:'+COLOR[r]+'"></span>'+LABEL[r]+'</div>';});}
  else if(colorMode==="worstpts"){h='<h4>Worst inspection (points)</h4>';[[0,"0 — clean"],[15,"15"],[40,"40"],[80,"80"],[150,"150+ — extreme"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+wpColor({wp:p[0]})+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no inspections</div>';}
  else if(colorMode==="avg"){h='<h4>Avg of last 5 inspections</h4>';[[1,"Excellent (1.0)"],[2,"Good (2.0)"],[3,"Okay (3.0)"],[4,"Needs improve (4.0)"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+avgColor({ra:p[0]})+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no history</div>';}
  else if(colorMode==="poorfrac"){h='<h4>% routines Okay-or-worse</h4>';[[0,"0% — always clean"],[0.34,"~⅓ of routines"],[0.67,"~⅔ of routines"],[1,"100% — always poor"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+pfColor({pf:p[0]})+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no routine inspections</div>';}
  else if(colorMode==="age"){h='<h4>Years on record</h4>';AGE_PAL.forEach(function(c,i){h+='<div class="lg"><span class="sw" style="background:'+c+'"></span>'+AGE_LBL[i]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>unknown</div>';}
  else if(colorMode==="resid"){h='<h4>vs cuisine norm</h4>';[[1.1,"much better than peers"],[0.5,"better"],[0,"typical for its cuisine"],[-0.5,"worse"],[-1.1,"much worse than peers"]].forEach(function(p){h+='<div class="lg"><span class="sw" style="background:'+residColorAt(p[0])+'"></span>'+p[1]+'</div>';});h+='<div class="lg"><span class="sw" style="background:#555"></span>no rating</div>';}
  else{h='<h4>Cuisine</h4>';var seen={};ALL.forEach(function(d){seen[cuGroup(d.cu)]=1;});GROUP_ORDER.filter(function(g){return seen[g]&&(fCuisine||(g!=="grocery"&&g!=="industry"&&g!=="other"));}).forEach(function(g){h+='<div class="lg"><span class="sw" style="background:'+(CU_COLOR[g]||"#555")+'"></span>'+(CU_LABEL[g]||g)+'</div>';});}
  el.innerHTML=h;
}
function recolor(){render();renderLegend();}   // drawMarkers re-styles dots / rebuilds emoji icons
function fmtDate(s){if(!s)return"";var d=new Date(s);return isNaN(d)?s:d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});}

// start collapsed on small screens so the map gets the whole viewport (tap "Filters" to open)
if(window.matchMedia("(max-width:720px)").matches) document.getElementById("feed").classList.add("collapsed");
var map=L.map("map",{preferCanvas:true}).setView([47.7,-122.1],10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {maxZoom:19,attribution:'&copy; OpenStreetMap · Public Health—Seattle &amp; King County, Snohomish County Health Dept'}).addTo(map);
var canvas=L.canvas({padding:.5});
// enlarge the tap target for the small canvas dots — by default only a pixel-perfect hit on the
// 7px circle registers (the big emoji markers don't have this problem), so a near-miss tap feels
// like the dot "isn't clickable". This pads the hit radius to ~tap size without enlarging the dot.
L.CircleMarker.prototype._clickTolerance=function(){return (this.options.stroke?this.options.weight/2:0)+11;};
var layer=L.layerGroup().addTo(map);
var emojiLayer=L.layerGroup(), emojiMode=true, EMOJI_ZOOM=15, lastVis=[], popupOpen=false;

var ALL=[], LOC=[], MARK=[], maxAge=20, WPMAX=150;   // LOC = establishments clustered by ~proximity
var fCuisine="", coOn={k:1,s:1}, query="";
// the rating-style range filter follows the "shade by" dropdown: METRIC is the active metric
// config (value accessor + min/max/step/label/format), fRange is its current [lo,hi]. Cuisine
// mode has no numeric metric (METRIC=null) so the slider is hidden. MET is built after load
// because worstpts/age maxima come from the data.
var MET={}, METRIC=null, fRange=[1,4], curVisEst=[];
// each metric: val=accessor, fmt=range label for the slider, disp=single-value label for the list row
function buildMetrics(){MET={
  rating:{label:"Rating",min:1,max:4,step:1,val:function(d){return d.r;},fmt:function(a,b){return a===b?RLABELS[a]:RLABELS[a]+" – "+RLABELS[b];},disp:function(d){return LABEL[ratingOf(d)];}},
  avg:{label:"Avg of last 5",min:1,max:4,step:0.1,val:function(d){return d.ra;},fmt:function(a,b){return a.toFixed(1)+" – "+b.toFixed(1);},disp:function(d){return d.ra==null?"no history":"avg "+d.ra.toFixed(1)+" / 4";}},
  routine:{label:"Last routine rating",min:1,max:4,step:1,val:function(d){return d.rr;},fmt:function(a,b){return a===b?RLABELS[a]:RLABELS[a]+" – "+RLABELS[b];},disp:function(d){return d.rr==null?"no routine":LABEL[d.rr]+" (routine)";}},
  worstpts:{label:"Worst inspection (pts)",min:0,max:WPMAX,step:5,val:function(d){return d.wp;},fmt:function(a,b){return a+" – "+(b>=WPMAX?b+"+":b)+" pts";},disp:function(d){return d.wp==null?"no inspections":d.wp+" pts worst";}},
  poorfrac:{label:"% routines Okay-or-worse",min:0,max:100,step:5,val:function(d){return d.pf==null?null:Math.round(d.pf*100);},fmt:function(a,b){return a+"% – "+b+"%";},disp:function(d){return d.pf==null?"no routine":Math.round(d.pf*100)+"% poor routines";}},
  age:{label:"Years in operation",min:0,max:maxAge,step:1,val:function(d){return ageOf(d);},fmt:function(a,b){return a+(b>=maxAge?" – "+b+"+":" – "+b)+" yr";},disp:function(d){var a=ageOf(d);return a==null?"age unknown":a+"y on record";}},
  // residual is signed: POSITIVE = better than the cuisine's mean. hiWorse:false flips the list sort.
  resid:{label:"vs cuisine norm",min:-1.3,max:1.3,step:0.1,hiWorse:false,val:function(d){return residOf(d);},
    fmt:function(a,b){return a.toFixed(1)+" … "+b.toFixed(1)+" vs peers";},
    disp:function(d){var v=residOf(d);return v==null?"no rating":(v>=0?"+":"")+v.toFixed(2)+" vs "+(CU_LABEL[d.cu]||"cuisine")+" norm";}}
};}
// switch the range filter to the metric matching the current shade-by mode; rebuilds the slider
// and resets the range to fully-open. Caller re-renders.
function applyMetric(mode){
  METRIC=MET[mode]||null;
  var field=document.getElementById("rfield");
  if(!METRIC){field.style.display="none";return;}
  field.style.display="";
  document.getElementById("rlabel").textContent=METRIC.label;
  fRange=[METRIC.min,METRIC.max];
  dualSlider(document.getElementById("rslider"),METRIC.min,METRIC.max,[METRIC.min,METRIC.max],
    function(v){fRange=v;render();},
    function(a,b){document.getElementById("rval").textContent=METRIC.fmt(a,b);},METRIC.step);
}
function reprOf(vm){var w=vm[0];for(var i=1;i<vm.length;i++)if(ratingOf(vm[i])>ratingOf(w))w=vm[i];return w;}  // worst-rated member represents the group
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
  if(fCuisine && d.cu!==fCuisine) return false;
  if(colorMode==="cuisine"&&!fCuisine){var g=cuGroup(d.cu);if(g==="grocery"||g==="industry"||g==="other")return false;}   // hide non-cuisine groups in cuisine view
  if(colorMode==="worstpts"&&d.wp==null) return false;     // no inspections — hide from worst-points view
  if(colorMode==="poorfrac"&&d.pf==null) return false;     // no routine inspections — hide from chronic view
  if(METRIC){                                              // range filter follows the shade-by metric
    var v=METRIC.val(d), full=(fRange[0]<=METRIC.min&&fRange[1]>=METRIC.max);
    if(v==null){ if(!full) return false; }                 // no value for this metric: only when fully open
    else if(v<fRange[0]||v>fRange[1]) return false;
  }
  if(query){var h=(d.n+" "+(d.a||"")+" "+(d.ci||"")).toLowerCase();if(h.indexOf(query)<0)return false;}
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
function emojiIcon(loc){var vm=loc._vm,rp=reprOf(vm),col=colorOf(rp),em=CU_EMOJI[rp.cu]||"🍴",n=vm.length;
  var badge=n>1?'<div style="position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#111;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;box-shadow:0 0 0 1.5px #fff">'+n+'</div>':'';
  // 38px element (bigger touch target) with the 26px colored disc centered; whole element taps
  return L.divIcon({className:"em",iconSize:[38,38],iconAnchor:[19,19],popupAnchor:[0,-16],
    html:'<div style="position:relative;width:26px;height:26px;margin:6px"><div style="width:26px;height:26px;border-radius:50%;background:'+col+';display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px rgba(0,0,0,.55);font-size:15px;line-height:1">'+em+'</div>'+badge+'</div>'});}
function emojiMarker(loc){var m=L.marker([loc.la,loc.lo],{icon:emojiIcon(loc),keyboard:false});
  m.on("click",function(){openLocPopup(loc);});return m;}
function updateEmojiHint(){var el=document.getElementById("emojihint");if(el)el.textContent=(emojiMode&&map.getZoom()<EMOJI_ZOOM)?"— zoom in for emoji ↗":"";}
function renderList(){
  var b=map.getBounds(),vis=curVisEst.filter(function(d){return b.contains([d.la,d.lo]);});   // only what's in view
  var flip=(METRIC&&METRIC.hiWorse===false)?-1:1;                                               // resid: higher = better, so flip
  function sv(d){var v=METRIC?METRIC.val(d):ratingOf(d);return v==null?-Infinity:flip*v;}        // normalized so higher = worse
  vis.sort(function(a,b){return sortDir*(sv(b)-sv(a))|| a.n.localeCompare(b.n);});
  document.getElementById("count").textContent=vis.length.toLocaleString()+" places";
  var cap=Math.min(vis.length,400),h="";
  for(var i=0;i<cap;i++){var d=vis[i];
    var lead=(METRIC&&METRIC.disp)?METRIC.disp(d):LABEL[ratingOf(d)];   // the shade-by value being sorted on
    h+='<div class="item" data-id="'+esc(d.id)+'"><div class="bar" style="background:'+colorOf(d)+'"></div>'+
       '<div><div class="nm">'+esc(d.n)+'</div>'+
       '<div class="ad">'+esc(d.a||"")+(d.ci?", "+esc(d.ci):"")+'</div>'+
       '<div class="mt"><b style="color:var(--ink)">'+esc(lead)+'</b> · '+(CU_LABEL[d.cu]||"Other")+'</div></div></div>';
  }
  if(vis.length>cap)h+='<div class="item" style="cursor:default;color:#6e7681">+ '+(vis.length-cap).toLocaleString()+' more — narrow the filters to see them</div>';
  var L2=document.getElementById("list");L2.innerHTML=h;
  L2.querySelectorAll(".item[data-id]").forEach(function(el){el.onclick=function(){focusId(el.getAttribute("data-id"));};});
}
function focusId(id){for(var i=0;i<ALL.length;i++){if(ALL[i].id===id){var d=ALL[i],loc=d._loc;
  if(loc)openLocPopup(loc,d,true);return;}}}   // true = leave the map where it is (the list is already viewport-scoped)

// ── popups (lazy detail) ──────────────────────────────────────────────────────
function popupShell(d){
  var r=ratingOf(d),h='<img class="sv" src="/streetview?lat='+d.la+'&lon='+d.lo+'" onerror="this.style.display=\'none\'" data-lat="'+d.la+'" data-lon="'+d.lo+'" title="Click for 360° view">';
  h+='<div class="pp-name">'+esc(d.n)+'</div>';
  h+='<span class="pp-badge" style="background:'+COLOR[r]+(r===2?";color:#1a1a00":"")+'">'+LABEL[r]+'</span>';
  h+='<div class="pp-addr">'+esc(d.a||"")+(d.ci?", "+esc(d.ci):"")+(d.z?" "+esc(d.z):"")+'</div>';
  h+='<div class="pp-meta">'+COUNTY[d.co]+' · '+(CU_LABEL[d.cu]||"Other")+'</div>';
  if(d.co==="k"&&d.g!=null) h+='<div class="pp-meta">Grade <b>'+d.g+'</b> ('+LABEL[d.g]+')'+(d.rs?" · "+esc(d.rs):"")+'</div>';
  if(d.s!=null) h+='<div class="pp-meta">'+(d.co==="k"?"Inspection score":"Violation points")+': <b>'+d.s+'</b> <span style="color:#999">(lower is better)</span></div>';
  if(d.ra!=null) h+='<div class="pp-meta">Avg rating, last 5 inspections: <b>'+d.ra.toFixed(1)+'</b> / 4</div>';
  if(d.wp!=null&&d.wp>(d.s||0)) h+='<div class="pp-meta">Worst inspection on record: <b>'+d.wp+'</b> pts</div>';
  var ln=[]; if(d.d)ln.push("inspected "+fmtDate(d.d)); if(d.fd)ln.push("on record since "+String(d.fd).slice(0,4));
  if(ln.length) h+='<div class="pp-meta" style="color:#666">'+ln.join(" · ")+'</div>';
  h+='<div class="pp-detail"><div class="loading">Loading inspection detail…</div></div>';
  return h;
}
function detailHtml(j){
  var h="";
  var v=j.violations||[];
  if(v.length){h+='<div class="pp-sec"><h4>Most recent violations</h4>';
    v.slice(0,8).forEach(function(x){
      var tag=x.type?'<span class="vt" style="background:'+(x.type==="RED"?"#e5484d":"#3b82f6")+'">'+esc(x.type)+(x.points!=null?" "+x.points:"")+'</span>':"";
      h+='<div class="viol"><div class="vh">'+tag+esc(x.label||"")+'</div>'+(x.note?'<div class="note">'+esc(x.note)+'</div>':"")+'</div>';
    });
    if(v.length>8)h+='<div style="font-size:11px;color:#888">+'+(v.length-8)+' more</div>';
    h+='</div>';
  } else h+='<div class="pp-sec"><h4>Most recent violations</h4><div style="font-size:11.5px;color:#2a8a4a">No violations recorded ✓</div></div>';
  var hist=j.history||[];
  if(hist.length>1){h+='<div class="pp-sec"><h4>Inspection history</h4>';
    hist.slice(0,6).forEach(function(x){h+='<div class="hist"><span>'+fmtDate(x.date)+(x.label?' · '+esc(x.label):"")+'</span><span>'+(x.score!=null?x.score+" pts":"")+'</span></div>';});
    h+='</div>';}
  if(j.report_url)h+='<a class="pp-link" href="'+esc(j.report_url)+'" target="_blank" rel="noopener">Official report →</a>';
  return h;
}
function wirePopup(root,d){
  if(!root)return;
  var box=root.querySelector(".pp-detail");
  if(box&&!box.dataset.loaded){box.dataset.loaded="1";
    fetch("/api/detail?id="+encodeURIComponent(d.id)).then(function(r){return r.json();}).then(function(j){box.innerHTML=detailHtml(j);}).catch(function(){box.innerHTML="";});}
  var sv=root.querySelector(".sv");
  if(sv)sv.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();var f=document.createElement("iframe");f.src="/sv-embed?lat="+d.la+"&lon="+d.lo;f.style.cssText="width:100%;height:150px;border:0;border-radius:6px;display:block;margin-bottom:7px";sv.parentNode.replaceChild(f,sv);};
}
function bindPopupOpen(m,d){m.on("popupopen",function(e){wirePopup(e.popup.getElement(),d);});}
// popup for a location: 1 establishment -> its detail; several -> a tappable list -> drill into detail
function locListHtml(vm){
  var a=vm[0],h='<div class="pp-name">'+vm.length+' establishments here</div>';
  h+='<div class="pp-addr">'+esc(a.a||"")+(a.ci?", "+esc(a.ci):"")+(a.z?" "+esc(a.z):"")+'</div>';
  h+='<div style="max-height:250px;overflow:auto;margin-top:6px">';
  vm.forEach(function(d,i){var r=ratingOf(d);
    h+='<div class="loc-row" data-i="'+i+'" style="display:flex;align-items:center;gap:8px;padding:6px 2px;border-top:1px solid #eee;cursor:pointer">'
      +'<span style="width:22px;height:22px;border-radius:50%;background:'+COLOR[r]+';display:flex;align-items:center;justify-content:center;font-size:13px;flex:none">'+(CU_EMOJI[d.cu]||"🍴")+'</span>'
      +'<span style="flex:1;min-width:0"><b style="font-size:12.5px;color:#111">'+esc(d.n)+'</b><br><span style="color:#777;font-size:11px">'+LABEL[r]+' · '+(CU_LABEL[d.cu]||"Other")+'</span></span>'
      +'<span style="color:#bbb;font-size:16px">›</span></div>';});
  return h+'</div>';
}
function openLocPopup(loc,focusD,noPan){
  var vm=loc.m.filter(passes);if(!vm.length)return;
  vm.sort(function(a,b){return ratingOf(b)-ratingOf(a)||a.n.localeCompare(b.n);});
  var pop=L.popup({maxWidth:300,minWidth:280,autoPan:!noPan}).setLatLng([loc.la,loc.lo]).openOn(map);
  function showList(){pop.setContent(locListHtml(vm));setTimeout(function(){var root=pop.getElement();if(!root)return;
    root.querySelectorAll(".loc-row").forEach(function(el){el.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();showDetail(vm[+el.dataset.i]);};});},0);}
  function showDetail(d){pop.setContent((vm.length>1?'<div class="loc-back" style="margin-bottom:6px;font-size:11.5px;color:#0969da;cursor:pointer">&larr; '+vm.length+' at this address</div>':'')+popupShell(d));
    setTimeout(function(){var root=pop.getElement();if(!root)return;wirePopup(root,d);var b=root.querySelector(".loc-back");if(b)b.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();showList();};},0);}
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
  Object.keys(cu).sort(function(a,b){return (CU_LABEL[a]||a).localeCompare(CU_LABEL[b]||b);}).forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=(CU_LABEL[k]||k)+" ("+cu[k]+")";sel.appendChild(o);});
  sel.onchange=function(){fCuisine=sel.value;render();};
  // range filter — follows the shade-by metric (rebuilt by applyMetric)
  applyMetric(colorMode);
  // shade-by dropdown: re-point the range filter at the new metric, then recolor
  document.getElementById("colorby").onchange=function(){colorMode=this.value;applyMetric(colorMode);recolor();};
  if(j.updated){var u=new Date(j.updated);document.getElementById("upd").textContent="Updated "+(isNaN(u)?j.updated:u.toLocaleDateString());}
  render();renderLegend();
  var la=ALL.map(function(d){return d.la;}),lo=ALL.map(function(d){return d.lo;});
  if(ALL.length)map.fitBounds([[Math.min.apply(0,la),Math.min.apply(0,lo)],[Math.max.apply(0,la),Math.max.apply(0,lo)]],{padding:[20,20]});
});
var qt;document.getElementById("q").oninput=function(e){clearTimeout(qt);var v=e.target.value.toLowerCase();qt=setTimeout(function(){query=v;render();},180);};
// flip the list sort order (worst-first <-> best-first) by clicking the "worst first" label
document.getElementById("sortdir").onclick=function(){sortDir=-sortDir;this.textContent=sortDir>0?"worst first":"best first";renderList();};
// click the title bar to collapse/expand the filter+list panel (frees the map, esp. on mobile)
document.getElementById("head").onclick=function(e){if(e.target.id==="q"||e.target.tagName==="INPUT"||e.target.closest(".statslink"))return;
  if(!window.matchMedia("(max-width:720px)").matches)return;   // collapse only on mobile
  document.getElementById("feed").classList.toggle("collapsed");
  setTimeout(function(){map.invalidateSize();},210);};
// 📍 locate the user, drop a marker, and zoom in
var meMarker=null;
document.getElementById("loc").onclick=function(e){e.stopPropagation();var btn=this;
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
// in emoji mode, re-cull to the new viewport (and switch dots<->emoji across the zoom threshold).
// DEBOUNCED: a tap on mobile jitters the map slightly -> moveend; without the delay the re-cull
// would destroy the tapped marker before its click lands, so taps never register. The delay lets
// the click fire (opening the popup, which then suppresses the re-cull) first.
var reCull=null;
map.on("moveend",function(){renderList();   // list follows the visible map region
  if(!emojiMode)return;clearTimeout(reCull);reCull=setTimeout(function(){if(emojiMode&&!popupOpen)drawMarkers(lastVis);},220);});
map.on("popupopen",function(){popupOpen=true;clearTimeout(reCull);});
map.on("popupclose",function(){popupOpen=false;if(emojiMode)drawMarkers(lastVis);});
// register the service worker so the app is installable / works offline (PWA)
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(function(){});
</script></body></html>`;

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
<title>SnoKing Food Safety — Ratings by Area</title>
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
    /* keep the zoom buttons clear of the panel overlay */
    .leaflet-top.leaflet-left{top:auto;left:auto;bottom:12px;right:12px}
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

var map=L.map("map",{preferCanvas:true}).setView([47.75,-122.1],9);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  {maxZoom:18,subdomains:"abcd",attribution:"&copy; OpenStreetMap &copy; CARTO · Census ACS · King &amp; Snohomish health depts"}).addTo(map);
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
</script></body></html>`;

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
<title>SnoKing Food Safety — Inspection Bloopers</title>
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
  <p class="sub">Real lines from Snohomish County food-inspection reports. <a href="/">← back to the map</a></p>
</header>
<div id="tools">
  <input id="q" placeholder="Search the bloopers…" autocomplete="off">
  <span id="count">…</span>
</div>
<div id="grid"><div class="loading">Loading the good stuff…</div></div>
<script>
var ALL=[],q="";
function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
function fmt(d){if(!d)return"";var x=new Date(d);return isNaN(x)?d:x.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});}
function card(b){
  return '<div class="card"><div class="em">'+(b.tag||"😅")+'</div>'+
    '<div class="quote">"'+esc(b.text)+'"</div>'+
    '<div class="vlabel">'+esc(b.label||"")+'</div>'+
    '<div class="meta"><b>'+esc(b.name)+'</b>'+(b.city?' · '+esc(b.city):'')+(b.date?' · '+fmt(b.date):'')+
      (b.report_url?' · <a href="'+esc(b.report_url)+'" target="_blank" rel="noopener">report ↗</a>':'')+'</div></div>';
}
function render(){
  var list=ALL.filter(function(b){return !q||((b.text+" "+b.name+" "+(b.label||"")).toLowerCase().indexOf(q)>=0);});
  document.getElementById("count").textContent=list.length.toLocaleString()+(q?" matching":"")+" bloopers";
  document.getElementById("grid").innerHTML=list.length?list.map(card).join(""):'<div class="loading">No matches.</div>';
}
fetch("/api/bloopers").then(function(r){return r.json();}).then(function(j){
  ALL=(j.items||[]);
  // light shuffle so it's not all one facility in a row, but keep it deterministic enough
  ALL.sort(function(a,b){return (a.date<b.date?1:a.date>b.date?-1:0)|| (a.name<b.name?-1:1);});
  render();
});
var t;document.getElementById("q").oninput=function(e){clearTimeout(t);var v=e.target.value.toLowerCase();t=setTimeout(function(){q=v;render();},160);};
</script></body></html>`;
