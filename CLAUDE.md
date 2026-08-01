# auto-news-video

API + worker + UI dựng video bản tin tiếng Việt dọc 9:16 từ **storyboard + file giọng đọc**.
Render bằng HyperFrames, đẩy MP4 lên Google Drive. Toàn bộ hình là chữ và đồ họa.

## Nguyên tắc kiến trúc — đọc trước khi sửa

**Chỉ một bước dùng LLM.** Trong cả pipeline, việc duy nhất cần trí tuệ là chia bản tin
thành cảnh và đặt tiêu đề (`src/plan.mjs`). Mọi bước khác là script tất định. Đừng thêm
lời gọi LLM vào các bước còn lại — chúng phải chạy lại ra kết quả y hệt.

**Đầu ra LLM luôn phải qua schema.** `validateChapters()` chặn trước khi dữ liệu đi tiếp;
sai thì retry, hỏng tiếp thì rơi về `fallbackChapters()`. Job không bao giờ được chết vì
LLM trả JSON rác.

**Repo này KHÔNG chứa source HyperFrames.** Pipeline gọi CLI bản npm
(`npx --yes hyperframes@<HYPERFRAMES_VERSION>`). Cần đọc source framework thì mở
`../hyperframes/` (repo riêng trên máy) hoặc github.com/heygen-com/hyperframes.

**Job bất đồng bộ, concurrency 1.** Video dưới 10 phút vẫn tốn ~40-50 phút CPU. Render
đã ăn hết CPU nên chạy song song chỉ làm cả hai cùng chậm.

## Chạy

```bash
npm install && pip install -r requirements.txt
cp .env.example .env      # bắt buộc điền API_TOKEN
npm run doctor            # kiểm tra ffmpeg, faster-whisper, claude, RAM
npm start                 # UI: http://localhost:8080/?token=<API_TOKEN>
```

## Cấu trúc

```
src/server.mjs        API + UI + hàng đợi FIFO
src/pipeline.mjs      orchestration 10 bước (transcribe → Drive)
src/storyboard.mjs    parse bảng markdown → script.txt + bản đồ ảnh
src/adscan.mjs        dò quảng cáo TTS chèn trong giọng đọc
src/plan.mjs          gọi Claude Code + validate schema + fallback
src/drive.mjs         OAuth refresh token + resumable upload
src/store.mjs         job store trên hệ thống file (không database)
src/ui.mjs            trang quản lý, HTML server-render, không build step
src/db.mjs            kết nối PostgreSQL cho bảng lịch + tạo schema (CREATE TABLE IF NOT EXISTS)
src/schedule.mjs      CRUD bảng lịch + nhặt dòng đến hạn nguyên tử (FOR UPDATE SKIP LOCKED)
src/scheduler.mjs     vòng tick: chạy/chờ/bỏ lỡ một dòng lịch, đối soát dòng đang bay với job.status
src/schedule-validate.mjs   kiểm tra storyboard/ảnh/thời lượng audio trước khi lưu một dòng lịch
templates/vn-news-vertical/   design system + generator — xem README riêng trong đó
work/<job_id>/      input, log, artifact của từng job
```

## Quy ước

- **Không thêm framework cho UI.** Trang quản lý là HTML render phía server; thêm React
  hay bundler vào chỉ để hiện một danh sách là không đáng.
- **Dependency tối thiểu.** Hiện có ba: `hono` + `@hono/node-server`, và `postgres`
  (porsager) cho bảng lịch. Google Drive dùng `fetch` trần chứ không kéo `googleapis`.
  Chọn `postgres` vì nó 0 dependency con và dùng tagged template (`` sql`...` ``) tự
  tham số hoá câu lệnh — không cần thêm lớp ORM hay ORM query-builder chỉ để chống
  SQL injection cho một bảng duy nhất.
- **Composition phải qua `npx hyperframes lint` và `check` sạch lỗi** trước khi render.
- **Render tất định**: không `Date.now()`, không `Math.random()` chưa gieo hạt, không
  fetch mạng lúc render.

## Bẫy đã gặp, đừng vấp lại

- **Quảng cáo TTS**: bản free của vb.vn chèn câu quảng cáo vào giữa hoặc cuối file giọng
  đọc. VAD của whisper bỏ qua nó nên nó *không có trong transcript nhưng vẫn nằm trong
  audio*. `src/adscan.mjs` dò bằng khoảng lặng > 3s và `volumedetect` (im lặng thật
  ≈ −91 dB, có tiếng nói ≈ −20 dB).
- **Đường dẫn ảnh trong storyboard** hay có dấu gạch dưới (`image_1.png`). Đừng dùng hàm
  dọn markdown chung cho ô đó — nó xoá `_` và ảnh sẽ im lặng biến mất khỏi video.
- **ASR trên CPU dùng faster-whisper**, không dùng whisper.cpp (chậm ~44× realtime).
- **Google Drive với Gmail cá nhân phải dùng OAuth refresh token**, không dùng service
  account: file do nó tạo thuộc về nó, mà nó có hạn mức lưu trữ = 0 → `storageQuotaExceeded`.
- **LEAD/TAIL** (2.6s / 2.4s) phải khớp giữa `align_script.py` và lệnh `ffmpeg` pad audio.
  Lệch là caption trôi khỏi giọng đọc.
- **Bộ hẹn giờ cần `TZ=Asia/Ho_Chi_Minh`.** VPS mặc định chạy UTC — thiếu biến này, dòng
  lịch hẹn 09:00 sẽ đợi tới 16:00 giờ Việt Nam mới chạy, và video ra lệch 7 tiếng so với
  ý người đặt lịch. Dockerfile đã set sẵn `ENV TZ`; chạy ngoài Docker thì tự khai trong
  `.env`.
