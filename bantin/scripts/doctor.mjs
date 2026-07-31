#!/usr/bin/env node
// Kiểm tra máy đã đủ điều kiện chạy pipeline chưa. Chạy sau khi deploy VPS.
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

for (const [cmd, label] of [["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"], ["python3", "python3"]]) {
  const v = await has(cmd, cmd === "python3" ? ["--version"] : ["-version"]);
  v ? ok(`${label}: ${v.slice(0, 60)}`) : bad(`${label} không có trên PATH`);
}

const claude = await has(process.env.CLAUDE_BIN || "claude");
claude ? ok(`claude: ${claude}`) : warn("claude không có — pipeline sẽ luôn dùng bố cục fallback");

console.log("\nPython:");
try {
  await pexec("python3", ["-c", "import faster_whisper"]);
  ok("faster_whisper");
} catch {
  bad("faster_whisper chưa cài — pip install -r requirements.txt");
}

console.log("\nCấu hình:");
process.env.API_TOKEN ? ok("API_TOKEN") : bad("API_TOKEN trống — server sẽ từ chối mọi request");
existsSync("templates/vn-news-vertical/build.mjs") ? ok("template vn-news-vertical") : bad("thiếu templates/vn-news-vertical");

const driveKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
const missing = driveKeys.filter((k) => !process.env[k]);
if (missing.length === 0) {
  ok("Google Drive credential đủ");
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) warn("chưa đặt GOOGLE_DRIVE_FOLDER_ID — file sẽ vào thư mục gốc Drive");
} else {
  warn(`Drive chưa cấu hình (thiếu ${missing.join(", ")}) — video chỉ nằm trên VPS`);
}

console.log("\nTài nguyên:");
const cpus = (await import("node:os")).cpus().length;
const gb = Math.round((await import("node:os")).totalmem() / 1073741824);
cpus >= 4 ? ok(`${cpus} vCPU`) : warn(`${cpus} vCPU — render sẽ rất chậm, nên có >= 4`);
gb >= 8 ? ok(`${gb} GB RAM`) : warn(`${gb} GB RAM — mỗi Chrome worker ~1 GB, nên có >= 8`);

console.log(fatal ? `\n${fatal} lỗi chặn. Sửa xong chạy lại.\n` : "\nSẵn sàng.\n");
process.exit(fatal ? 1 : 0);
