// One-time: re-score existing Snohomish with King's RISK-TIERED window — N=4 routines for high-risk
// (Risk III), N=2 for low/medium-risk (Risk I/II), matching King's own method. Rating-only (violations
// already tagged). Sets prev_rating = new rating -> zero notifications. Recomputes from stored detail.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ratingKingStyle, riskN } from "./king-rubric.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const d1 = (sql) => JSON.parse(execSync(`npx wrangler d1 execute snoking-foodsafety --remote --json --command ${JSON.stringify(sql)}`, { maxBuffer: 1 << 30 }))[0].results;
const rubric = JSON.parse(readFileSync(join(HERE, "king_violation_map.json"), "utf8"));

const rows = d1("SELECT id, rating, detail FROM establishments WHERE county='snohomish'");
const now = Date.now(); let sql = "", changed = 0;
for (const r of rows) {
  let det; try { det = JSON.parse(r.detail); } catch { continue; }
  const ng = ratingKingStyle(det.history || [], rubric, riskN(det.category));
  if (ng != null && ng !== r.rating) { changed++; sql += `UPDATE establishments SET rating=${ng}, prev_rating=${ng}, updated_at=${now} WHERE id='${r.id.replace(/'/g, "''")}';\n`; }
}
writeFileSync(join(HERE, "_migrate_risktier.sql"), sql);
console.log(`Snohomish: ${rows.length} rows, ${changed} rating changes (${(100 * changed / rows.length).toFixed(1)}%) -> _migrate_risktier.sql`);
