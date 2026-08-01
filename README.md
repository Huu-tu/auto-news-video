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

Bảng lịch tạo video giờ bắt buộc PostgreSQL — server `process.exit(1)` ngay khi khởi
động nếu không kết nối được `DATABASE_URL`. Chạy đúng theo mỗi `npm start` mà thiếu
Postgres thì app không lên được.

```bash
npm install
pip install -r requirements.txt
python3 -c "import static_ffmpeg.run as r; print(r.get_or_fetch_platform_executables_else_raise())"
# symlink ffmpeg/ffprobe vào ~/.local/bin nếu máy chưa có

# Cần một PostgreSQL đang chạy, vd. Docker cho gọn:
docker run -d --name bantin-pg -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=bantin -p 5432:5432 postgres:16

cp .env.example .env      # bắt buộc điền API_TOKEN và DATABASE_URL
npm run doctor            # kiểm tra máy đủ điều kiện chưa
npm start
```

Yêu cầu: Node ≥ 22, Python 3, ffmpeg/ffprobe, PostgreSQL, và `claude` CLI (thiếu thì
luôn dùng bố cục fallback). VPS nên có **≥ 4 vCPU / 8 GB RAM** — mỗi Chrome worker ăn ~1 GB.

**`TZ=Asia/Ho_Chi_Minh` là bắt buộc** nếu dùng bảng lịch. VPS mặc định chạy giờ UTC —
thiếu biến này thì hẹn 09:00 sẽ chạy lúc 16:00 giờ Việt Nam, và ngày đổi lệch theo.

Docker: `docker build -t bantin-studio . && docker run -p 8080:8080 --env-file .env -v bantin:/data bantin-studio`
(container tự có `TZ=Asia/Ho_Chi_Minh`, nhưng `DATABASE_URL` vẫn phải trỏ ra một
PostgreSQL bên ngoài container — Dockerfile không đóng gói database).

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
| GET | `/health` | Trạng thái tiến trình + bộ hẹn giờ, dùng cho HEALTHCHECK |

Field ảnh đặt tên `image_<id>`, trong đó `<id>` là **tên file không đuôi** ghi ở cột
"Hình ảnh gợi ý" của storyboard. `/prompts /image/image_1.png` → gửi field `image_image_1`.

**Mã lỗi** (`error.code`): `bad_input`, `asr_empty`, `align_failed`, `lint_failed`,
`check_failed`, `render_failed`, `interrupted`, `internal_error`, `timeout` (job vượt
trần `JOB_TIMEOUT_MS`, không thử lại tự động).

**Video đã upload Drive thì file local bị dọn.** Sau khi Drive nhận file thành công,
pipeline xoá `output.mp4`, `project/` và `input/` trong thư mục job để giải phóng đĩa —
`GET /v1/jobs/{id}/video` và `/v1/jobs/{id}/project/*` sẽ trả 404 cho những job này.
Dùng link Drive trong `status.drive.link` để lấy video, không dùng hai endpoint đó.

## UI

`http://VPS:8080/?token=<API_TOKEN>` — danh sách template, danh sách video, form tạo job,
tiến độ realtime, log khi lỗi. HTML render phía server, không build step.

`http://VPS:8080/schedule?token=<API_TOKEN>` — lịch tạo video tự động: đặt giờ chạy,
xem trạng thái từng dòng (`pending`/`queued`/`running`/`done`/`failed`/`missed`), sửa,
xoá, bật/tắt, hoặc bấm chạy ngay. **Giờ hiển thị trên mỗi dòng là giờ SẼ chạy, không
phải giờ hẹn gốc** — khi một job lỗi được thử lại, `run_at` bị dời tới mốc retry
(`SCHEDULE_RETRY_DELAY_MS` sau lần thử trước), cột giờ phản ánh mốc mới đó.

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
3. `ALERT_WEBHOOK` trong `.env` — bắn POST khi job fail (Telegram/Slack). Có hai dạng
   payload: job lẻ (`POST /v1/jobs`) gửi `{job_id, error}`; dòng lịch (`/schedule`) gửi
   `{event: "schedule_missed" | "schedule_failed", schedule_id, name, ...}` — bỏ lỡ hẳn
   một lịch (trễ quá `SCHEDULE_GRACE_HOURS`) không tạo job nào nên không có `job_id`,
   phải phân biệt bằng `event`.

Ngoài ra khi tiến trình khởi động lại, mọi job đang dở bị đánh dấu `failed` với mã
`interrupted` thay vì treo mãi ở trạng thái `rendering`.

## Cấu trúc

```
src/
  server.mjs           API + UI + hàng đợi FIFO
  pipeline.mjs         orchestration 10 bước
  storyboard.mjs       parse bảng markdown → script.txt + bản đồ ảnh
  adscan.mjs           dò quảng cáo TTS (gap > 3s, volumedetect)
  plan.mjs             gọi Claude Code + validate schema + fallback
  drive.mjs            OAuth refresh token + resumable upload
  store.mjs            job store trên hệ thống file (mỗi job một thư mục)
  ui.mjs               trang quản lý
  db.mjs               kết nối PostgreSQL (postgres/porsager) + migrate schema bảng lịch
  schedule.mjs         CRUD bảng lịch, nhặt dòng đến hạn nguyên tử (FOR UPDATE SKIP LOCKED)
  scheduler.mjs        vòng tick: quyết định chạy/chờ/bỏ lỡ, đối soát job đang bay
  schedule-validate.mjs kiểm tra storyboard/ảnh/thời lượng audio trước khi lưu một dòng lịch
templates/vn-news-vertical/   design system + generator (xem README riêng)
work/<job_id>/                input, log, artifact — mỗi job một thư mục
work/schedule/<id>/           input gốc của một dòng lịch (audio + ảnh + storyboard)
```

Job store (`store.mjs`) vẫn trên hệ thống file như trước; PostgreSQL chỉ phục vụ riêng
bảng lịch tạo video (`schedule.mjs`) — hai nguồn sự thật tách biệt, đồng bộ qua
`job_id`/`video_link` chứ không dùng chung một database.

Xoá một job = xoá thư mục `work/<job_id>/`.

## Quảng cáo TTS chèn giữa file

TTS tiếng Việt bản free chèn câu quảng cáo vào giữa hoặc cuối file giọng đọc. VAD của
whisper bỏ qua nó nên nó **không có trong transcript nhưng vẫn nằm trong audio**.
[`adscan.mjs`](src/adscan.mjs) tự dò bằng hai dấu hiệu: khoảng lặng > 3s giữa hai
segment, và đuôi file sau segment cuối (im lặng thật ≈ −91 dB, có tiếng nói ≈ −20 dB).
Có chốt an toàn: tổng lát cắt vượt 1/3 file thì bỏ hết, vì đó là dấu hiệu dò sai.
