// One-time: re-score King's UNGRADED establishments (schools/institutions) with the King-style
// rubric, matching how graded King places and Snohomish are now scored. Rating-only (King
// violations already carry type+points). Sets prev_rating = new rating -> no notifications.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ratingKingStyle } from "./king-rubric.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const d1 = (sql) => JSON.parse(execSync(`npx wrangler d1 execute snoking-foodsafety --remote --json --command ${JSON.stringify(sql)}`, { maxBuffer: 1 << 30 }))[0].results;
const rubric = JSON.parse(readFileSync(join(HERE, "king_violation_map.json"), "utf8"));

const rows = d1("SELECT id, rating, detail FROM establishments WHERE county='king' AND grade IS NULL AND rating IS NOT NULL");
const now = Date.now(); let sql = "", changed = 0;
for (const r of rows) {
  let det; try { det = JSON.parse(r.detail); } catch { continue; }
  const ng = ratingKingStyle(det.history || [], rubric);
  if (ng != null && ng !== r.rating) { changed++; sql += `UPDATE establishments SET rating=${ng}, prev_rating=${ng}, updated_at=${now} WHERE id='${r.id.replace(/'/g, "''")}';\n`; }
}
const out = join(HERE, "_migrate_king.sql");
import("node:fs").then((fs) => fs.writeFileSync(out, sql));
console.log(`King ungraded: ${rows.length} rows, ${changed} rating changes -> ${out}`);
