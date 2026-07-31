# Bản tin Studio

API + worker + UI dựng video bản tin tiếng Việt dọc 9:16 từ **storyboard + file giọng đọc**,
render bằng [HyperFrames](https://hyperframes.heygen.com), rồi tự đẩy MP4 lên Google Drive.

Toàn bộ hình là chữ và đồ họa — không footage người thật.

```
POST /v1/jobs  (multipart: storyboard.md + audio.mp3 + ảnh)
   → 202 {job_id}
   → hàng đợi → worker:
        transcribe → dò quảng cáo TTS → align kịch bản
        → [Claude Code soạn bản đồ cảnh] → validate schema
        → build → lint → check → render
        → upload Google Drive
   → status = done
```

## Vì sao thiết kế như vậy

**Chỉ một bước dùng LLM.** Trong cả pipeline, việc duy nhất thật sự cần trí tuệ là
chia bản tin thành cảnh và đặt tiêu đề. Mọi bước còn lại là script tất định — chạy
lại cho ra kết quả y hệt, debug được, không tốn token. Đầu ra của bước LLM bị
[`validateChapters()`](src/plan.mjs) chặn: sai schema thì retry, hỏng tiếp thì rơi về
bố cục mặc định. LLM trả rác cũng không giết job.

**Job bất đồng bộ.** Một video dưới 10 phút vẫn tốn ~20–40 phút CPU (transcribe +
render). Không HTTP đồng bộ nào chịu nổi, nên API trả `job_id` ngay và làm việc dưới nền.

**Concurrency = 1.** Render đã ăn hết CPU; chạy hai job song song chỉ làm cả hai cùng chậm.

## Cài đặt

```bash
npm install
pip install -r requirements.txt
python3 -c "import static_ffmpeg.run as r; print(r.get_or_fetch_platform_executables_else_raise())"
# symlink ffmpeg/ffprobe vào ~/.local/bin nếu máy chưa có

cp .env.example .env      # bắt buộc điền API_TOKEN
npm run doctor            # kiểm tra máy đủ điều kiện chưa
npm start
```

Yêu cầu: Node ≥ 22, Python 3, ffmpeg/ffprobe, và `claude` CLI (thiếu thì luôn dùng
bố cục fallback). VPS nên có **≥ 4 vCPU / 8 GB RAM** — mỗi Chrome worker ăn ~1 GB.

Docker: `docker build -t bantin-studio . && docker run -p 8080:8080 --env-file .env -v bantin:/data bantin-studio`

## Dùng API

```bash
curl -X POST http://VPS:8080/v1/jobs \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Idempotency-Key: bantin-2026-07-27" \
  -F 'payload={"brand":{"name":"BẢN TIN","sub":"TÀI CHÍNH","date":"27 · 07"}}' \
  -F "audio=@vo.mp3" \
  -F "storyboard=@prompts.md" \
  -F "image_image_1=@gold.png"
```

| Method | Path | |
|---|---|---|
| POST | `/v1/jobs` | Tạo job |
| GET | `/v1/jobs/{id}` | Trạng thái + tiến độ |
| GET | `/v1/jobs/{id}/events` | SSE tiến độ realtime |
| GET | `/v1/jobs/{id}/video` | Tải MP4 |
| GET | `/v1/jobs/{id}/logs` | Log (khi failed) |
| POST | `/v1/jobs/{id}/cancel` | Huỷ |
| GET | `/v1/jobs` · `/v1/templates` | Danh sách (UI dùng) |

Field ảnh đặt tên `image_<id>`, trong đó `<id>` là **tên file không đuôi** ghi ở cột
"Hình ảnh gợi ý" của storyboard. `/prompts /image/image_1.png` → gửi field `image_image_1`.

**Mã lỗi** (`error.code`): `bad_input`, `asr_empty`, `align_failed`, `lint_failed`,
`check_failed`, `render_failed`, `interrupted`, `internal_error`.

## UI

`http://VPS:8080/?token=<API_TOKEN>` — danh sách template, danh sách video, form tạo job,
tiến độ realtime, log khi lỗi. HTML render phía server, không build step.

## Google Drive

Tài khoản Gmail cá nhân phải dùng **OAuth refresh token**, không dùng được service
account: file do service account tạo sẽ thuộc về nó, mà nó có hạn mức lưu trữ = 0 →
`storageQuotaExceeded`. Share thư mục không đổi được chủ sở hữu.

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run drive:auth
```

Trên Google Cloud Console nhớ **Publish app sang Production** — để ở Testing thì Google
thu hồi refresh token sau 7 ngày và pipeline chết lặng lẽ.

Chưa cấu hình Drive thì job vẫn chạy, video nằm lại trên VPS kèm cảnh báo
`drive_not_configured`.

## Không có callback thì biết job hỏng kiểu gì

Job xong thì video tự xuất hiện trong Drive. Job **hỏng** thì im lặng — mà im lặng
trông y hệt "đang chạy". Ba lớp bảo vệ:

1. UI hiện job `failed` kèm log
2. `GET /v1/jobs?status=failed`
3. `ALERT_WEBHOOK` trong `.env` — bắn POST khi job fail (Telegram/Slack)

Ngoài ra khi tiến trình khởi động lại, mọi job đang dở bị đánh dấu `failed` với mã
`interrupted` thay vì treo mãi ở trạng thái `rendering`.

## Cấu trúc

```
src/
  server.mjs      API + UI + hàng đợi FIFO
  pipeline.mjs    orchestration 10 bước
  storyboard.mjs  parse bảng markdown → script.txt + bản đồ ảnh
  adscan.mjs      dò quảng cáo TTS (gap > 3s, volumedetect)
  plan.mjs        gọi Claude Code + validate schema + fallback
  drive.mjs       OAuth refresh token + resumable upload
  store.mjs       job store trên hệ thống file (không database)
  ui.mjs          trang quản lý
templates/vn-news-vertical/   design system + generator (xem README riêng)
work/<job_id>/                input, log, artifact — mỗi job một thư mục
```

Xoá một job = xoá thư mục `work/<job_id>/`.

## Quảng cáo TTS chèn giữa file

TTS tiếng Việt bản free chèn câu quảng cáo vào giữa hoặc cuối file giọng đọc. VAD của
whisper bỏ qua nó nên nó **không có trong transcript nhưng vẫn nằm trong audio**.
[`adscan.mjs`](src/adscan.mjs) tự dò bằng hai dấu hiệu: khoảng lặng > 3s giữa hai
segment, và đuôi file sau segment cuối (im lặng thật ≈ −91 dB, có tiếng nói ≈ −20 dB).
Có chốt an toàn: tổng lát cắt vượt 1/3 file thì bỏ hết, vì đó là dấu hiệu dò sai.
