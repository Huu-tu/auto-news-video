import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getSql, initSchema } from "../src/db.mjs";

const WORK_DIR = resolve(process.env.WORK_DIR || "./work");
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(WORK_DIR)) {
  console.error(`Không thấy thư mục ${WORK_DIR}`);
  process.exit(1);
}

const sql = getSql();
await initSchema(sql);

const COLUMNS = ["job_id", "status", "created_at", "started_at", "updated_at"];

let found = 0;
let inserted = 0;
let skipped = 0;
const broken = [];

for (const name of readdirSync(WORK_DIR)) {
  if (!name.startsWith("job_")) continue;
  const p = join(WORK_DIR, name, "status.json");
  if (!existsSync(p)) continue;

  found++;
  let status;
  try {
    status = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    broken.push(`${name}: ${e.message}`);
    continue;
  }

  const data = { ...status };
  for (const c of COLUMNS) delete data[c];

  if (dryRun) {
    console.log(`[dry-run] ${name} — ${status.status}`);
    inserted++;
    continue;
  }

  const rows = await sql`
    INSERT INTO job (job_id, status, created_at, started_at, updated_at, data)
    VALUES (
      ${status.job_id || name},
      ${status.status || "failed"},
      ${status.created_at ? new Date(status.created_at) : new Date()},
      ${status.started_at ? new Date(status.started_at) : null},
      ${status.updated_at ? new Date(status.updated_at) : new Date()},
      ${sql.json(data)}
    )
    ON CONFLICT (job_id) DO NOTHING
    RETURNING job_id`;

  if (rows.length) inserted++;
  else skipped++;
}

console.log(`\nĐọc ${found} file status.json`);
console.log(`  nạp mới : ${inserted}${dryRun ? " (dry-run, chưa ghi gì)" : ""}`);
console.log(`  đã có   : ${skipped}`);
if (broken.length) {
  console.log(`  hỏng    : ${broken.length}`);
  for (const b of broken) console.log(`    - ${b}`);
}

await sql.end({ timeout: 5 });
