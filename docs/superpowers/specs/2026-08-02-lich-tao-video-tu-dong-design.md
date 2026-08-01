# Lịch tạo video tự động

**Ngày:** 2026-08-02 · **Trạng thái:** đã duyệt, chờ lên kế hoạch triển khai

## Bối cảnh

Hiện tại pipeline chạy theo cơ chế **đẩy**: một hệ thống bên ngoài gọi `POST /v1/jobs`
kèm storyboard + file ghi âm + ảnh, server nhận và dựng video.

Chuyển sang cơ chế **kéo**: server tự giữ một bảng lịch, đến giờ tự chạy. Người dùng
nhập lịch và upload file qua UI của chính app, không gọi API từ ngoài nữa.

Mọi thứ nặng của pipeline — transcribe, LLM soạn cảnh, render, upload Drive — **không
đổi một dòng**. Lịch chỉ là một cái vòi mới rót vào cùng `runJob()` đã có.

## Mục tiêu

1. Bảng lịch quản lý trong UI của app: tạo, sửa, bật/tắt, xoá, chạy ngay
2. Đến giờ hẹn, server tự đẩy dòng lịch vào hàng đợi sẵn có
3. Video xong tự lên `GOOGLE_DRIVE_FOLDER_ID` như hiện tại
4. Chạy không người trông mà vẫn đáng tin: bắt lỗi sớm, báo khi hỏng, không tự chết vì
   đầy đĩa hay job treo

## Phạm vi

**Trong phạm vi**

- Bảng `schedule` trong PostgreSQL + trang `/schedule` trong UI
- Bộ hẹn giờ tick 30 giây, có chạy bù và bỏ lỡ theo ngưỡng
- Validate dữ liệu ngay lúc nhập (storyboard, ảnh, độ dài audio)
- Thử lại có phân loại theo `error.code`
- Dọn `work/<job_id>/` sau khi upload Drive thành công
- Cài đặt `JOB_TIMEOUT_MS` cho thật hoạt động + timeout cho `fetch` upload Drive

**Ngoài phạm vi** — xem mục [Những gì không làm](#những-gì-không-làm)

---

## 1. Kiến trúc

### Ranh giới dữ liệu

```
PostgreSQL  →  metadata dòng lịch: giờ hẹn, tên, storyboard, ghi chú,
               công tắc bật/tắt, trạng thái, số lần thử, lỗi cuối,
               job_id, link video

Đĩa         →  work/schedule/<id>/input/vo.<ext>      file ghi âm
               work/schedule/<id>/input/images/       ảnh
               work/<job_id>/                         artifact của job (giữ nguyên)
```

**Nguyên tắc:** PostgreSQL trả lời *"chạy cái gì, lúc nào"*. Đĩa trả lời *"lần chạy đó
ra sao"*. Nối nhau qua cột `job_id`.

Storyboard lưu thẳng vào cột `text` trong PostgreSQL, không thành file — nó là văn bản
vài KB, người dùng dán trực tiếp vào ô trên UI. Đến lúc chạy mới ghi ra
`input/storyboard.md` cho pipeline đọc.

Audio và ảnh bắt buộc là file thật vì ffmpeg, faster-whisper và Chrome đều nhận đường
dẫn file.

### Job store giữ nguyên trên đĩa

[`src/store.mjs`](../../../src/store.mjs) **không** chuyển sang PostgreSQL. Lý do:

- Job là trạng thái tạm thời của một lần chạy, sống cùng đống artifact quanh nó
  (`asr.json`, `chapters.json`, `logs.ndjson`, `output.mp4`, thư mục `project/`). Tách
  metadata sang DB mà artifact ở đĩa thì lại tạo ra đúng vấn đề hai nguồn sự thật.
- Đang chạy tốt, đã có `reapInterrupted()` xử lý restart. Chuyển sang PG là viết lại
  một thứ không hỏng.

Chuyển job sang PostgreSQL là một dự án riêng, làm được bất cứ lúc nào về sau.

### Module mới

| File | Trách nhiệm | Phụ thuộc |
|---|---|---|
| `src/db.mjs` | Kết nối PostgreSQL, tạo bảng lúc khởi động | `postgres` |
| `src/schedule.mjs` | CRUD dòng lịch + nhặt dòng đến hạn | `db.mjs` |
| `src/scheduler.mjs` | Vòng tick, quyết định chạy/bù/bỏ, đối soát | `schedule.mjs`, hàng đợi |

**Tách quyết định khỏi tác dụng phụ.** `scheduler.mjs` chứa các hàm thuần
(`decideAction`, `isRetryable`) không đọc DB, không ghi file, không đụng đồng hồ hệ
thống — nhận `now` làm tham số. Nhờ vậy test được mà không phải chờ thật.

### Driver

Dùng `postgres` (porsager) — **0 dependency kéo theo**, cú pháp tagged template tự tham
số hoá nên không nối chuỗi SQL được kể cả muốn.

`package.json` đi từ 2 lên 3 dependency.

---

## 2. Schema

```sql
CREATE TABLE IF NOT EXISTS schedule (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,               -- Tên
  run_at      timestamptz NOT NULL,               -- Ngày + Giờ gộp lại
  storyboard  text        NOT NULL,               -- Storyboard
  note        text        NOT NULL DEFAULT '',    -- Ghi Chú
  enabled     boolean     NOT NULL DEFAULT true,  -- công tắc người dùng

  -- hệ thống ghi, người dùng không sửa
  status      text        NOT NULL DEFAULT 'pending',
  attempts    int         NOT NULL DEFAULT 0,
  job_id      text,
  video_link  text,
  last_error  text,
  claimed_at  timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedule_due_idx
  ON schedule (run_at) WHERE enabled AND status = 'pending';
```

Tạo bằng `CREATE TABLE IF NOT EXISTS` lúc server khởi động. Một bảng thì không cần
framework migration.

### Hai quyết định cần giải thích

**`enabled` tách khỏi `status`.** Cột `Trạng Thái` trong bảng gốc gánh hai ý nghĩa
khác nhau: công tắc do người dùng bật/tắt, và trạng thái do hệ thống ghi. Gộp một cột
thì lúc job xong, hệ thống ghi `done` đè lên `Enable` và mất thông tin dòng đó có được
bật hay không. Tách ra còn cho phép chuẩn bị trước lịch cả tuần, dòng nào chưa sẵn sàng
thì để tắt.

**`Ngày` + `Giờ` gộp thành `run_at timestamptz`.** Tách hai cột sẽ gây phiền: so sánh
phải ghép lại, sắp xếp sai khi qua nửa đêm, và không biểu diễn được múi giờ. UI vẫn
hiện hai ô nhập, chỉ ghép lại trước khi lưu.

**Ảnh và audio không có cột nào** — tìm theo `id` tại `work/schedule/<id>/input/`.

---

## 3. Vòng đời

```
              ┌──────────────────────────────────┐
              │  enabled = false → tick bỏ qua   │
              └──────────────────────────────────┘

                  đến giờ, trễ < ngưỡng
  pending ──────────────────────────────► claimed ──► queued ──► running
     ▲                                                              │
     │                                                              ▼
     │  lỗi tạm thời, attempts < max (chờ 5 phút)                  done
     ├──────────────────────────────────────────────┐               │
     │                                              │               │
     │                                        lỗi dữ liệu, hoặc hết lượt
     │                                              │
     │                                              ▼
     └──── trễ > ngưỡng ────► missed             failed
```

| Trạng thái | Ai đặt | Ý nghĩa |
|---|---|---|
| `pending` | mặc định | Chưa tới giờ, hoặc đang chờ được nhặt |
| `claimed` | tick, nguyên tử | Đã nhặt, đang ghi file ra đĩa. Chỉ tồn tại vài giây |
| `queued` | tick | Đã đẩy vào hàng đợi FIFO, có `job_id` |
| `running` | đối soát | Job đang chạy |
| `done` | đối soát | Xong, có `video_link` |
| `failed` | đối soát | Hỏng, không thử lại nữa |
| `missed` | tick | Quá ngưỡng trễ, sẽ không chạy |

`claimed` là trạng thái trung gian rất ngắn, tồn tại để việc nhặt dòng trở thành nguyên
tử (xem mục 4). Nếu server chết đúng khoảnh khắc đó, dòng sẽ kẹt ở `claimed` — tick sau
thấy `claimed_at` quá 10 phút thì trả về `pending`.

### Chính sách thử lại

Dựa trên `error.code` mà pipeline đã sinh sẵn:

| `error.code` | Xử lý | Vì sao |
|---|---|---|
| `interrupted` | 🔄 thử lại | Server restart giữa chừng |
| `render_failed` | 🔄 thử lại | Chrome crash / hết RAM — thường ngẫu nhiên |
| `internal_error` | 🔄 thử lại | Gồm lỗi mạng lúc upload Drive |
| `bad_input` | ⛔ dừng | Thiếu file, sai định dạng — lặp lại y hệt |
| `asr_empty` | ⛔ dừng | File ghi âm không có tiếng nói |
| `align_failed` | ⛔ dừng | Storyboard không khớp file ghi âm |
| `lint_failed` · `check_failed` | ⛔ dừng | Xem ghi chú dưới |
| `timeout` | ⛔ dừng | Xem ghi chú dưới |

Tối đa **2 lần thử lại**, cách nhau 5 phút (`SCHEDULE_MAX_ATTEMPTS`,
`SCHEDULE_RETRY_DELAY_MS`).

*Ghi chú `lint_failed`/`check_failed`:* về lý thuyết có thể qua khi thử lại, vì bố cục
cảnh do LLM sinh nên mỗi lần một khác. Nhưng xác suất thấp mà mỗi lần tốn 45–70 phút
CPU và chặn các dòng phía sau. Đổi quyết định chỉ là chuyển một mã giữa hai danh sách.

*Ghi chú `timeout`:* đắt nhất trong mọi loại lỗi — thử lại tốn thêm 2 tiếng mỗi lượt,
đủ để đẩy các dòng còn lại sang `missed`. Mà treo hiếm khi ngẫu nhiên: thường do hết
RAM, đầy đĩa, hoặc dữ liệu vào có vấn đề.

---

## 4. Vòng tick

Chạy mỗi `SCHEDULE_TICK_MS` (mặc định 30 giây) bằng `setInterval` trong chính tiến
trình server. Không dùng thư viện cron: lịch chạy một lần rồi thôi, không có lịch lặp,
và độ chính xác cần thiết là phút chứ không phải giây.

Render chạy trong tiến trình con nên event loop của Node gần như rảnh suốt — tick không
bị trễ vì CPU bận.

Mỗi tick làm **hai việc**:

### Việc 1 — Nhặt dòng đến hạn

```sql
UPDATE schedule SET status = 'claimed', claimed_at = now(), updated_at = now()
WHERE id = (
  SELECT id FROM schedule
  WHERE enabled AND status = 'pending' AND run_at <= now()
  ORDER BY run_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` khiến thao tác nhặt trở thành nguyên tử. Kể cả tick chạy chồng
lên nhau, một dòng lịch không bao giờ bị dựng thành hai video.

Nhặt xong: ghi `storyboard` ra `input/storyboard.md`, tạo job qua đường nội bộ (dùng lại
`writeStatus` + `enqueue`), lưu `job_id`, chuyển sang `queued`.

Dòng quá ngưỡng `SCHEDULE_GRACE_HOURS` tính từ `run_at` → `missed`.

### Việc 2 — Đối soát dòng đang bay

Với mọi dòng `queued`/`running`: đọc `status.json` của `job_id` tương ứng, cập nhật lại
trạng thái, `video_link`, `last_error`.

Đây là chỗ hệ thống **tự lành sau restart**: `reapInterrupted()` đã đánh dấu job
`failed[interrupted]`, tick nhìn thấy và cho dòng lịch quay về `pending` để thử lại.
Dòng kẹt ở `claimed` quá 10 phút cũng được trả về `pending` theo cùng cơ chế.

### Về ngưỡng chạy bù

Ngưỡng tính từ `run_at`, **không phân biệt** server tắt hay hàng đợi đang tắc. Mỗi video
tốn 45–70 phút và chỉ chạy một job một lúc.

> **Quy tắc chọn ngưỡng:** `SCHEDULE_GRACE_HOURS ≥ số video hẹn trong ngày × 1.2`
> Hẹn 6 video/ngày → để 8.

---

## 5. UI

Hai trang, dùng chung header và CSS đã có:

| Đường dẫn | Nội dung |
|---|---|
| `/` | Bảng điều khiển hiện tại — danh sách job, template (**giữ nguyên**) |
| `/schedule` | Trang lịch mới |

Vẫn là HTML render phía server, **không framework, không build step**. Nâng cấp duy
nhất: dùng `html` tagged template của `hono/html` (đã nằm trong package `hono`) thay cho
hàm `esc()` thủ công — escape mặc định, muốn chèn HTML thô thì phải nói rõ `raw()`.

### Bảng lịch

| ID | Ngày | Giờ | Tên | Chạy? | Trạng thái |
|---|---|---|---|---|---|
| 12 | 29/07/2026 | 09:00 | Tin tức vàng | 🟢 Bật | ✅ Xong · [mở video] |
| 13 | 30/07/2026 | 09:00 | Tin tài chính | 🟢 Bật | ⏳ Đang chạy · render 62% |
| 14 | 30/07/2026 | 14:00 | Tin thể thao | 🟢 Bật | 🕐 Chờ đến giờ |
| 15 | 31/07/2026 | 09:00 | Bản nháp | ⚪ Tắt | 🕐 Chờ đến giờ |
| 16 | 28/07/2026 | 09:00 | Tin cũ | 🟢 Bật | ❌ Lỗi · storyboard không khớp ghi âm |

Bấm vào dòng → `<dialog>` xem chi tiết: storyboard đầy đủ, danh sách ảnh, log job.

Dòng đã `done` hiện thêm `plan_source`. Thấy `fallback` là biết bước LLM không chạy —
xem mục [Điều kiện tiên quyết](#điều-kiện-tiên-quyết).

Nút trên mỗi dòng: `Bật/Tắt` · `Sửa` · `Chạy ngay` · `Xoá`

- **`Chạy ngay`** bỏ qua giờ hẹn, đẩy thẳng vào hàng đợi. Dùng để test và chạy lại dòng
  `failed`/`missed`.
- **`Xoá`** xoá cả dòng DB lẫn thư mục `work/schedule/<id>/` trong một thao tác.

### Form thêm lịch

Một `<form enctype="multipart/form-data">`:

| Trường | Kiểu nhập |
|---|---|
| Tên | `text` |
| Ngày | `<input type="date">` |
| Giờ | `<input type="time">` |
| Storyboard | `<textarea>` |
| File ghi âm | `<input type="file" accept="audio/*">` |
| Hình ảnh | `<input type="file" multiple accept="image/*">` |
| Ghi chú | `<textarea>` |
| Bật ngay | `<input type="checkbox" checked>` |

### Validate ngay lúc lưu

Đây là lợi ích lớn nhất của việc chọn UI làm nguồn nhập liệu. Cả ba kiểm tra đều nhanh,
không cần LLM, không cần transcribe:

1. **Chạy `parseStoryboard()`** — hiện số dòng thoại đọc được và danh sách id ảnh mà
   storyboard tham chiếu. Không đọc được dòng nào → chặn, không cho lưu.
2. **Đối chiếu ảnh với storyboard** — storyboard nhắc `image_1`…`image_4` mà chỉ upload
   3 ảnh → cảnh báo *"thiếu ảnh `image_3`"*. Hiện tại lỗi này chỉ lộ ra sau khi render
   xong và ngồi xem mới phát hiện ảnh biến mất.
3. **So thời lượng audio với storyboard** — `ffprobe` lấy độ dài file, ước lượng độ dài
   kịch bản theo ~150 âm tiết/phút, lệch quá 30% thì cảnh báo.

Kiểm tra 3 bắt được đúng lỗi có thật trong `prompts/`: audio 887 giây, storyboard 5 dòng
≈ 76 giây. Chạy thật sẽ ra `align_failed` sau ~25 phút, hoặc tệ hơn là video 15 phút mà
chỉ 76 giây có caption.

**Mức độ chặn:** chỉ kiểm tra 1 chặn lưu — không có dòng thoại nào thì pipeline chắc
chắn hỏng. Kiểm tra 2 và 3 hiện cảnh báo nổi bật nhưng vẫn cho lưu, vì cả hai đều có
trường hợp cố ý hợp lệ: upload thiếu ảnh để bổ sung sau, hoặc ước lượng 150 âm tiết/phút
lệch với giọng đọc chậm/nhanh bất thường.

---

## 6. Vận hành

### Cấu hình mới

```bash
# ── Cơ sở dữ liệu ────────────────────────────────────────────
DATABASE_URL=postgres://user:pass@localhost:5432/bantin

# ── Bộ hẹn giờ ───────────────────────────────────────────────
TZ=Asia/Ho_Chi_Minh      # BẮT BUỘC. VPS mặc định UTC → hẹn 09:00 sẽ chạy lúc 16:00
SCHEDULE_TICK_MS=30000
SCHEDULE_GRACE_HOURS=8   # ≥ số video hẹn trong ngày × 1.2
SCHEDULE_MAX_ATTEMPTS=2
SCHEDULE_RETRY_DELAY_MS=300000

# ── Đã có sẵn, nay đổi giá trị mặc định ──────────────────────
JOB_TIMEOUT_MS=7200000   # 120 phút (cũ: 90 — quá sát với job dài)
```

`TZ` đưa luôn vào `Dockerfile`. `npm run doctor` in ra giờ hiện tại theo giờ server để
đối chiếu bằng mắt.

### Cảnh báo

`ALERT_WEBHOOK` đã có và đang bắn khi job fail. Mở rộng thêm:

| Sự kiện | Vì sao cần |
|---|---|
| Dòng lịch → `failed` | Đã có qua job; thêm tên dòng lịch cho dễ nhận |
| Dòng lịch → `missed` | **Mới** — video sẽ không bao giờ được dựng |
| Tick không chạy > 10 phút | **Mới** — dấu hiệu tiến trình treo |

`missed` là kiểu hỏng im lặng đúng nghĩa: không job nào fail, không log lỗi, chỉ đơn
giản là video không xuất hiện.

### Dọn `work/` sau khi upload Drive

**Sau khi upload Drive thành công**, xoá:

- `output.mp4`
- thư mục `project/`
- các file `.wav` trung gian

Giữ lại `status.json`, `logs.ndjson`, `transcript.json`, `chapters.json` (vài trăm KB).

Giảm ~95% dung lượng. Không có bước này thì 3 video/ngày ≈ **1,2 GB/ngày**, đầy 100 GB
sau khoảng ba tháng — và khi đĩa đầy thì mọi dòng lịch sau đó đều hỏng.

**Drive chưa cấu hình hoặc upload lỗi → không xoá gì.** Đó là bản sao duy nhất.

### Cài đặt `JOB_TIMEOUT_MS`

Biến này đang có trong `.env.example` nhưng **không dòng code nào đọc**. Chỉ bước gọi
`claude` có timeout riêng ([`plan.mjs`](../../../src/plan.mjs)); ffmpeg, `transcribe.py`,
`align_script.py`, `hyperframes render` và `fetch` upload Drive đều không có gì chặn.

Một tiến trình con không thoát → `await runJob()` treo vĩnh viễn → `running` không được
giải phóng → hàng đợi đóng băng. Ở chế độ hẹn giờ, một job treo làm **mọi dòng lịch phía
sau lần lượt chuyển sang `missed`**.

Cách sửa — dùng lại cơ chế mà nút Huỷ đã có (`children` map + SIGTERM):

```
quá JOB_TIMEOUT_MS
   → SIGTERM mọi tiến trình con đã đăng ký
   → chờ 10 giây, còn sống thì SIGKILL
   → đánh dấu job failed, error.code = "timeout"
   → giải phóng running, pump() chạy dòng kế tiếp
```

Kèm theo: đặt `AbortSignal.timeout(120000)` cho mỗi lát 8 MB trong
[`drive.mjs`](../../../src/drive.mjs). Việc này khiến vòng retry 3 lần sẵn có thực sự
hoạt động — treo sẽ biến thành lỗi ném ra, mà lỗi ném ra thì retry bắt được.

---

## 7. Kiểm thử

Dùng `node:test` có sẵn trong Node 22 — 0 dependency.

Không phủ test toàn bộ: render và transcribe cần binary thật và chạy hàng chục phút.
Test phần **thuần tính toán**, nơi dễ sai nhất:

| Hàm | Vào | Ra |
|---|---|---|
| `decideAction()` | `now`, `run_at`, `enabled`, `status`, `grace` | `run` / `wait` / `miss` |
| `isRetryable()` | `error.code`, `attempts` | `retry` / `stop` |
| `validateScheduleInput()` | storyboard, danh sách ảnh, độ dài audio | danh sách cảnh báo |

Các hàm này nhận `now` làm tham số thay vì gọi `Date.now()`, nên test được "trễ đúng 8
tiếng 1 phút", biên giới nửa đêm, và đổi múi giờ mà không phải chờ thật.

---

## Những gì không làm

| Không làm | Vì sao |
|---|---|
| Lịch lặp (cron hàng ngày) | Mỗi dòng gắn một file ghi âm riêng → lặp chỉ dựng lại cùng một video |
| Chạy nhiều instance server | Phải viết lại kiến trúc hàng đợi. `SKIP LOCKED` đã dọn đường sẵn |
| Sửa inline từng ô như Excel | Sửa qua form là đủ. Khi cần thì dùng htmx, không phải React |
| Nhiều người dùng, phân quyền | Vẫn một `API_TOKEN` |
| Lịch sử phiên bản storyboard | Chưa có nhu cầu |
| Chuyển job store sang PostgreSQL | Ranh giới đã chốt ở mục 1 |
| Framework migration | Một bảng, `CREATE TABLE IF NOT EXISTS` là đủ |
| Nhập lịch từ Google Sheets | UI là nguồn duy nhất |
| Bỏ `POST /v1/jobs` | Giữ nguyên, không đụng. Tiện để test pipeline mà không cần tạo dòng lịch |

---

## Điều kiện tiên quyết

Nằm ngoài thiết kế này nhưng quyết định chất lượng đầu ra:

**`claude` CLI phải được cài và xác thực trên server.** `Dockerfile` hiện **không cài
nó** (chỉ `npm install --omit=dev` cho 2 dependency của app). Thiếu thì mọi video hẹn
giờ đều dùng bố cục fallback — job vẫn báo `done`, video vẫn lên Drive, nhưng nội dung
nghèo hẳn: mỗi dòng thoại một thẻ `story` giống nhau, không `stat`, không `chart`,
không `tiles`.

Ở chế độ tự động điều này tệ hơn trước, vì không ai xem lại từng video để phát hiện.
Vì vậy trang lịch hiện rõ `plan_source` trên mỗi dòng đã xong.

Cần: `RUN npm install -g @anthropic-ai/claude-code` trong `Dockerfile` + `ANTHROPIC_API_KEY`
trong `.env`. Kiểm tra thật bằng `echo 'trả lời [1,2,3]' | claude -p --output-format json`
— `claude --version` chạy được kể cả khi chưa xác thực nên không chứng minh được gì.
