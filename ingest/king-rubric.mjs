// King-style scoring rubric, shared by the ingester and the one-time migration.
// Both counties inspect against the same WA Retail Food Code (WAC 246-215); King's data tags each
// item RED (critical/major) or BLUE (non-critical/minor) with a point value. We build that item map
// from King, then score Snohomish the SAME way King scores: average of CRITICAL (RED) points over
// the last 4 routine inspections, against thresholds derived from King's own grade distribution.
// The shared key is the WA item number, which both counties carry in the violation label
// (King "0600 Adequate handwashing", Snohomish "06 - Adequate handwashing").

export function item2(label) {            // leading WA item number, normalized to 2 digits
  const m = /^\s*(\d{2,4})/.exec(String(label || ""));
  return m ? m[1].slice(0, 2).padStart(2, "0") : null;
}
export function critPoints(vlist, map) {  // sum King RED points for the violations on one inspection
  let s = 0;
  for (const v of vlist || []) { const it = item2(v.label); if (it && map[it] && map[it].critical) s += map[it].points; }
  return s;
}
// stamp each violation with King's major/minor type (RED/BLUE) + point value, by WA item number,
// so Snohomish violations are self-describing and display the same way King's do.
export function tagViols(vlist, map) {
  return (vlist || []).map((v) => {
    const it = item2(v.label), m = it && map[it];
    return m ? { ...v, type: m.critical ? "RED" : "BLUE", points: m.points } : v;
  });
}
function avgCrit(history, map, n) {       // avg critical points over the last N routine inspections (newest-first)
  const rt = (history || []).filter((h) => /routine/i.test(h.svc || ""));
  const arr = rt.length ? rt.slice(0, n) : (history && history[0] ? [history[0]] : []);   // fallback: latest of any type
  if (!arr.length) return null;
  const sums = arr.map((h) => critPoints(h.v, map));
  return sums.reduce((a, b) => a + b, 0) / sums.length;
}
// King averages the last N routine inspections, where N depends on risk category: 4 for restaurants
// (Risk III / high risk), 2 for lower-risk establishments (Risk I & II). Snohomish's category field
// carries the same LOW/MEDIUM/HIGH RISK label, so we map it straight across.
export function riskN(category) {
  const c = (category || "").toUpperCase();
  if (c.includes("HIGH RISK")) return 4;
  if (c.includes("MEDIUM RISK") || c.includes("LOW RISK")) return 2;
  if (/SCHOOL|CAMP|CATERING/.test(c)) return 4;   // cook full meals but carry no explicit risk label
  return 2;                                        // vending, bakery, misc low-complexity
}
export function ratingKingStyle(history, rubric, n = 4) {   // -> 1..4 (lower better), or null if no inspections
  if (!rubric || !rubric.map || !rubric.cutoffs) return null;
  const a = avgCrit(history, rubric.map, n);
  if (a == null) return null;
  const [c1, c2, c3] = rubric.cutoffs;
  return a <= c1 ? 1 : a <= c2 ? 2 : a <= c3 ? 3 : 4;
}
// build {map: {item -> {critical, points}}, cutoffs:[c1,c2,c3]} from King establishment records
// (each needs .grade and .detail.history[].v[] with {label, type, points}).
export function buildKingRubric(kingRecs) {
  const typ = {}, pts = {};
  for (const r of kingRecs) for (const h of (r.detail && r.detail.history) || []) for (const v of h.v || []) {
    const it = item2(v.label); if (!it) continue;
    if (v.type === "RED" || v.type === "BLUE") { (typ[it] = typ[it] || {}); typ[it][v.type] = (typ[it][v.type] || 0) + 1; }
    if (v.points != null && isFinite(+v.points)) { (pts[it] = pts[it] || {}); pts[it][+v.points] = (pts[it][+v.points] || 0) + 1; }
  }
  const modal = (o, d) => { if (!o) return d; let k = d, m = -1; for (const x in o) if (o[x] > m) { m = o[x]; k = x; } return k; };
  const map = {};
  for (const it in typ) { const t = modal(typ[it], "BLUE"); map[it] = { critical: t === "RED", points: +modal(pts[it], t === "RED" ? "5" : "3") }; }
  // cutoffs: the avg-critical-points values that reproduce King's GRADED distribution
  // cutoffs are the category thresholds on "avg critical points per routine" — shared across risk tiers
  // (King uses the same categories, just averaged over N=2 or 4). Derive them from King's N=4 restaurants.
  const xs = [];
  for (const r of kingRecs) { if (r.grade == null) continue; const a = avgCrit((r.detail && r.detail.history) || [], map, 4); if (a != null) xs.push([a, r.grade]); }
  xs.sort((u, w) => u[0] - w[0]);
  const vals = xs.map((z) => z[0]), N = vals.length || 1, cnt = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const z of xs) cnt[z[1]]++;
  const at = (p) => vals[Math.min(N - 1, Math.floor(p * N))] || 0;
  const cutoffs = [at(cnt[1] / N), at((cnt[1] + cnt[2]) / N), at((cnt[1] + cnt[2] + cnt[3]) / N)];
  return { map, cutoffs, nItems: Object.keys(map).length };
}
