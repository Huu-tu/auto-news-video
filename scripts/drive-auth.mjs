import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 5788;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET trong biến môi trường.");
  process.exit(2);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // bắt buộc, nếu không Google sẽ không trả refresh_token ở lần cấp phép thứ hai
  });

async function exchange(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function report(tokens) {
  console.log("\n✓ Xong. Dán vào .env trên VPS:\n");
  console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
  console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\nCòn GOOGLE_DRIVE_FOLDER_ID lấy từ URL thư mục Drive:");
  console.log("  https://drive.google.com/drive/folders/<PHẦN_NÀY>\n");
  if (!tokens.refresh_token) {
    console.log("⚠ Google không trả refresh_token. Vào https://myaccount.google.com/permissions,");
    console.log("  gỡ quyền của app rồi chạy lại script này.\n");
  }
}

console.log("\nMở link này trong trình duyệt và cấp quyền:\n");
console.log(authUrl + "\n");

// VPS không có trình duyệt → cho dán code thủ công.
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") return res.end();
  const code = url.searchParams.get("code");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  try {
    const tokens = await exchange(code);
    res.end("<h2>Xong — quay lại terminal.</h2>");
    report(tokens);
  } catch (e) {
    res.end(`<h2>Lỗi: ${e.message}</h2>`);
    console.error(e.message);
  }
  server.close();
  process.exit(0);
});

server.listen(PORT, async () => {
  console.log(`Đang chờ callback ở ${REDIRECT} …`);
  console.log("(Chạy trên máy không có trình duyệt? Dán ?code=... vào đây rồi Enter)\n");
  // stdin có thể là /dev/null (chạy nền) — khi đó chỉ ngồi chờ callback loopback.
  let manual = "";
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    manual = ((await rl.question("code (bỏ trống nếu đã cấp quyền qua trình duyệt): ")) || "").trim();
    rl.close();
  }
  if (manual) {
    const code = manual.includes("code=") ? new URL(manual, "http://x").searchParams.get("code") : manual;
    try {
      report(await exchange(code));
    } catch (e) {
      console.error("Lỗi:", e.message);
    }
    server.close();
    process.exit(0);
  }
});
