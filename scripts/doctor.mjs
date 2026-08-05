import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const pexec = promisify(execFile);
let fatal = 0;

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  fatal++;
};
const warn = (m) => console.log(`  ! ${m}`);

async function has(cmd, args = ["--version"]) {
  try {
    const { stdout, stderr } = await pexec(cmd, args);
    return (stdout || stderr).split("\n")[0].trim();
  } catch {
    return null;
  }
}

console.log("\nbantin-studio doctor\n");

console.log("Binary:");
const node = process.versions.node;
Number(node.split(".")[0]) >= 22 ? ok(`node ${node}`) : bad(`node ${node} — cần >= 22`);

const PYTHON = process.env.PYTHON_BIN || "python3";
for (const [cmd, label] of [["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"], [PYTHON, "python (" + PYTHON + ")"]]) {
  const v = await has(cmd, cmd === PYTHON ? ["--version"] : ["-version"]);
  v ? ok(`${label}: ${v.slice(0, 60)}`) : bad(`${label} không có trên PATH`);
}

const claudeBin = process.env.CLAUDE_BIN || "claude";
const claudeVer = await has(claudeBin);
if (!claudeVer) {
  warn(`${claudeBin} không có trên PATH — pipeline sẽ luôn dùng bố cục fallback`);
} else {
  try {
    const extra = (process.env.CLAUDE_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
    const call = pexec(claudeBin, ["-p", "--output-format", "json", "--model", "haiku", ...extra], {
      timeout: 60000,
    });
    call.child.stdin.write("Trả lời đúng một mảng JSON: [1,2,3]");
    call.child.stdin.end();
    const { stdout } = await call;
    JSON.parse(stdout);
    ok(`claude: ${claudeVer} — xác thực OK`);
  } catch {
    bad(`claude: ${claudeVer} nhưng GỌI THẬT THẤT BẠI — kiểm tra ANTHROPIC_API_KEY. Mọi video sẽ dùng bố cục fallback.`);
  }
}

console.log("\nPython:");
try {
  await pexec(PYTHON, ["-c", "import faster_whisper"]);
  ok("faster_whisper");
} catch {
  bad("faster_whisper chưa cài — pip install -r requirements.txt");
}

console.log("\nCấu hình:");
process.env.API_TOKEN
  ? ok("API_TOKEN")
  : warn("API_TOKEN trống — KHÔNG XÁC THỰC, ai vào được cổng cũng toàn quyền. Chỉ dùng ở máy cá nhân hoặc sau VPN.");
existsSync("templates/vn-news-vertical/build.mjs") ? ok("template vn-news-vertical") : bad("thiếu templates/vn-news-vertical");

const driveKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
const missing = driveKeys.filter((k) => !process.env[k]);
if (missing.length === 0) {
  ok("Google Drive credential đủ");
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) warn("chưa đặt GOOGLE_DRIVE_FOLDER_ID — file sẽ vào thư mục gốc Drive");
} else {
  warn(`Drive chưa cấu hình (thiếu ${missing.join(", ")}) — video chỉ nằm trên VPS`);
}

if (process.env.DATABASE_URL) {
  try {
    const { getSql, initSchema, closeSql } = await import("../src/db.mjs");
    await initSchema(getSql());
    await closeSql();
    ok("PostgreSQL kết nối được, bảng schedule sẵn sàng");
  } catch (e) {
    bad(`PostgreSQL lỗi: ${e.message}`);
  }
} else {
  bad("DATABASE_URL trống — bảng lịch sẽ không chạy");
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const offsetHours = -new Date().getTimezoneOffset() / 60;
const nowLocal = new Date().toLocaleString("vi-VN");
offsetHours === 7
  ? ok(`múi giờ ${tz} (UTC+7) — bây giờ là ${nowLocal}`)
  : warn(
      `múi giờ ${tz} đang lệch UTC${offsetHours >= 0 ? "+" : ""}${offsetHours}, không phải UTC+7 — bây giờ là ${nowLocal}. ` +
        `Giờ hẹn sẽ lệch ${Math.abs(7 - offsetHours)} tiếng so với giờ Việt Nam. Đặt TZ=Asia/Ho_Chi_Minh.`,
    );

console.log("\nTài nguyên:");
const cpus = (await import("node:os")).cpus().length;
const gb = Math.round((await import("node:os")).totalmem() / 1073741824);
cpus >= 4 ? ok(`${cpus} vCPU`) : warn(`${cpus} vCPU — render sẽ rất chậm, nên có >= 4`);
gb >= 8 ? ok(`${gb} GB RAM`) : warn(`${gb} GB RAM — mỗi Chrome worker ~1 GB, nên có >= 8`);

console.log(fatal ? `\n${fatal} lỗi chặn. Sửa xong chạy lại.\n` : "\nSẵn sàng.\n");
process.exit(fatal ? 1 : 0);
