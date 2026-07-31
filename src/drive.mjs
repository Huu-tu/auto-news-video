// Upload video lên Google Drive bằng OAuth refresh token (tài khoản Gmail cá nhân).
//
// VÌ SAO KHÔNG DÙNG SERVICE ACCOUNT: file upload lên sẽ do service account sở
// hữu, mà service account có hạn mức lưu trữ = 0 → API trả storageQuotaExceeded.
// Share thư mục không đổi được chủ sở hữu. Với Gmail cá nhân, đường duy nhất là
// OAuth refresh token của chính bạn (file thuộc về bạn, tính vào 15 GB).
// Có Google Workspace thì dùng Shared Drive + service account sẽ sạch hơn.
//
// Scope dùng drive.file: app chỉ thấy file do chính nó tạo — không đọc được
// phần còn lại trong Drive của bạn.
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const CHUNK = 8 * 1024 * 1024; // 8 MB — bội số của 256 KB theo yêu cầu của Drive

export function driveConfigured(env = process.env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

export async function getAccessToken(env = process.env) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant = token bị thu hồi. Hay gặp nhất: OAuth app còn ở trạng thái
    // "Testing" — Google hết hạn refresh token sau 7 ngày. Publish sang Production.
    throw new Error(`Lấy access token thất bại (${res.status}): ${body.error || ""} ${body.error_description || ""}`.trim());
  }
  return body.access_token;
}

/** Đọc một lát file thành Buffer. */
function readChunk(path, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(path, { start, end })
      .on("data", (c) => chunks.push(c))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

/**
 * Resumable upload — video 9:16 dưới 10 phút thường 50–300 MB, upload một phát
 * hay đứt giữa chừng. Chia lát 8 MB, lát nào lỗi mạng thì thử lại riêng lát đó.
 *
 * @returns {{ id: string, name: string, webViewLink?: string }}
 */
export async function uploadToDrive(filePath, { folderId, filename, env = process.env, onProgress = () => {} }) {
  if (!driveConfigured(env)) throw new Error("Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");

  const accessToken = await getAccessToken(env);
  const size = statSync(filePath).size;
  const name = filename || basename(filePath);

  // 1. Khởi tạo session
  const initRes = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify({ name, mimeType: "video/mp4", ...(folderId ? { parents: [folderId] } : {}) }),
  });
  if (!initRes.ok) {
    throw new Error(`Khởi tạo upload thất bại (${initRes.status}): ${(await initRes.text()).slice(0, 300)}`);
  }
  const session = initRes.headers.get("location");
  if (!session) throw new Error("Drive không trả về URL session");

  // 2. Đẩy từng lát
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + CHUNK, size) - 1;
    const buf = await readChunk(filePath, offset, end);

    let res;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await fetch(session, {
          method: "PUT",
          headers: {
            "content-length": String(buf.length),
            "content-range": `bytes ${offset}-${end}/${size}`,
          },
          body: buf,
        });
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!res) throw new Error(`Upload lát ${offset}-${end} thất bại: ${lastErr?.message}`);

    // 308 = server đã nhận lát này, gửi tiếp
    if (res.status === 308) {
      const range = res.headers.get("range"); // "bytes=0-8388607"
      offset = range ? Number(range.split("-")[1]) + 1 : end + 1;
      onProgress(offset / size);
      continue;
    }
    if (res.ok) {
      const file = await res.json();
      onProgress(1);
      return { id: file.id, name: file.name, webViewLink: `https://drive.google.com/file/d/${file.id}/view` };
    }
    throw new Error(`Upload lỗi (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  throw new Error("Upload kết thúc mà Drive không xác nhận file");
}
