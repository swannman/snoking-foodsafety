// One-time migration: re-score Snohomish with King's exact rubric (critical-only points, averaged
// over last 4 routines, King-derived thresholds) AND tag every Snohomish violation with King's
// major/minor type + points. Sets prev_rating = new rating so the methodology change fires NO
// favorite notifications. Recomputable from stored detail — no re-crawl. Emits chunked SQL.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { buildKingRubric, ratingKingStyle, tagViols } from "./king-rubric.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const d1 = (sql) => JSON.parse(execSync(
  `npx wrangler d1 execute snoking-foodsafety --remote --json --command ${JSON.stringify(sql)}`,
  { maxBuffer: 1 << 30 }))[0].results;

// 1) Build King rubric from King's graded establishments
console.log("pulling King…");
const king = d1("SELECT grade, detail FROM establishments WHERE county='king' AND rating IS NOT NULL")
  .map((r) => ({ grade: r.grade, detail: JSON.parse(r.detail) }));
const rubric = buildKingRubric(king);
writeFileSync(join(HERE, "king_violation_map.json"), JSON.stringify(rubric));
console.log(`King rubric: ${rubric.nItems} items, cutoffs ${rubric.cutoffs.join("/")}`);

// 2) Re-score + tag Snohomish from stored detail
console.log("pulling Snohomish…");
const sno = d1("SELECT id, rating, detail FROM establishments WHERE county='snohomish'");
const now = Date.now();
const esc = (s) => s.replace(/'/g, "''");
let stmts = [], changed = 0, dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const r of sno) {
  let det; try { det = JSON.parse(r.detail); } catch { continue; }
  det.violations = tagViols(det.violations, rubric.map);
  det.history = (det.history || []).map((h) => ({ ...h, v: tagViols(h.v, rubric.map) }));
  const ng = ratingKingStyle(det.history, rubric);
  const detSql = "'" + esc(JSON.stringify(det)) + "'";
  if (ng != null && ng !== r.rating) {
    changed++; dist[ng]++;
    stmts.push(`UPDATE establishments SET detail=${detSql}, rating=${ng}, prev_rating=${ng}, updated_at=${now} WHERE id='${esc(r.id)}';`);
  } else {
    if (ng != null) dist[ng]++;
    stmts.push(`UPDATE establishments SET detail=${detSql}, updated_at=${now} WHERE id='${esc(r.id)}';`);   // tag violations, keep rating
  }
}
// 3) chunk the SQL (large detail blobs) so wrangler --file batches stay reasonable
const CHUNK = 300, files = [];
for (let i = 0; i < stmts.length; i += CHUNK) {
  const f = join(HERE, `_migrate_sno_${String(i / CHUNK).padStart(2, "0")}.sql`);
  writeFileSync(f, stmts.slice(i, i + CHUNK).join("\n") + "\n");
  files.push(f);
}
writeFileSync(join(HERE, "_migrate_files.json"), JSON.stringify(files));
console.log(`Snohomish: ${sno.length} rows, ${changed} rating changes (${(100 * changed / sno.length).toFixed(1)}%)`);
console.log(`new distribution: Exc ${dist[1]} Good ${dist[2]} Okay ${dist[3]} NeedsImp ${dist[4]}`);
console.log(`wrote ${files.length} SQL chunk files`);
