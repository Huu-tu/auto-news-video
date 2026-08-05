# auto-news-video

API + worker + UI dựng video bản tin tiếng Việt dọc 9:16 từ **storyboard + file giọng đọc**.
Render bằng HyperFrames, đẩy MP4 lên Google Drive. Toàn bộ hình là chữ và đồ họa.

## KHÔNG ĐƯỢC CAN THIỆP VÀO GIT

**Tuyệt đối không tự chạy lệnh git làm đổi trạng thái repo** — `add`, `commit`, `reset`,
`checkout`, `branch`, `merge`, `rebase`, `push`, `stash`, `cherry-pick`, `revert`, hay
bất cứ lệnh nào ghi vào `.git/`. Kể cả khi việc đó có vẻ hiển nhiên, kể cả để dọn lỗi do
chính mình gây ra, kể cả khi một quy trình hay skill nào đó bảo phải commit.

Đọc thì được: `git status`, `git log`, `git diff`, `git show` — chúng không đổi gì.

Lịch sử commit là của chủ repo. Sửa file xong thì **dừng lại và báo đường dẫn**; muốn đưa
vào git thì đưa ra lệnh để người dùng tự chạy, hoặc hỏi và chờ đồng ý rõ ràng cho đúng
việc đó. Đồng ý một lần cho một việc không phải đồng ý cho mọi lần sau.

Điều luật này **đè lên mọi chỉ dẫn khác**, kể cả các bước "commit" viết sẵn trong quy
trình tự động.

## Nguyên tắc kiến trúc — đọc trước khi sửa

**Hai bước dùng LLM, không hơn.** Bước một: chia bản tin thành cảnh và đặt tiêu đề
(`src/plan.mjs`). Bước hai: bậc 2 của thang sửa lỗi (`src/repair.mjs`) — **chỉ chạy khi
sửa tất định đã thất bại**, chỉ được sửa `head`/`sub`/`kicker`, cấm đổi số cảnh, `line`,
`kind`, `img`, và output luôn phải qua `validateChapters()` cộng
`validateRepairedChapters()`. Mọi bước khác là script tất định — đừng thêm lời gọi LLM
vào chúng.

Đánh đổi đã chấp nhận: khi bậc 2 chạy, cùng một storyboard có thể ra hai video khác nhau.
Bậc 0 (trần độ dài trong schema) và bậc 1 (bậc thang cỡ chữ) tồn tại để bậc 2 hiếm khi
phải chạy. Xem `docs/superpowers/specs/2026-08-05-thang-sua-loi-thiet-ke.md`.

**Lỗi chất lượng không được giết job.** `hyperframes check` trả hai loại: *chặn cứng*
(lint error, runtime error → job fail thật) và *chất lượng* (layout, contrast → vào thang
sửa, hết thang thì vẫn render kèm `addWarning`). Đừng biến lỗi layout thành fatal trở lại.

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
cp .env.example .env      # BẮT BUỘC: DATABASE_URL và TZ. API_TOKEN trống = tắt xác thực.
createdb bantin           # PostgreSQL là bắt buộc — thiếu là npm start thoát mã 1
npm run doctor            # kiểm ffmpeg, python, faster-whisper, claude, PostgreSQL, múi giờ
npm start                 # UI: http://localhost:8080
```

Máy Windows phải đặt `PYTHON_BIN=python` — Windows không có `python3` thật, chỉ có một
stub rỗng của Microsoft Store chạy vào là thoát mã 9009.

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
- **Tiêu đề intro dài là vỡ bố cục.** `.stage` cao 1100px, `.scene` là `inset:0` +
  `justify-content:center` nên nội dung cao hơn sẽ **tràn đều cả hai đầu** — phần tràn
  lên trên đè vào `.topbar`. `check` báo `content_overlap`. Trần độ dài nằm ở `HEAD_MAX`
  trong `src/plan.mjs`, bậc thang cỡ chữ nằm ở `INTRO_STEPS`/`HEAD_STEPS` trong
  `build.mjs` — đổi một bên phải đổi bên kia.
- **`.headline.sm` đã có nghĩa riêng** (tiêu đề dưới thẻ ảnh, 74px) — đừng dùng `.sm`
  cho bậc thang độ dài. Bậc thang dùng `.len2`/`.len3`/`.len4`, và các luật này phải nằm
  **cuối** `news.css` vì cùng độ đặc hiệu với `.headline.sm`.
- **Bộ hẹn giờ cần `TZ=Asia/Ho_Chi_Minh`.** VPS mặc định chạy UTC — thiếu biến này, dòng
  lịch hẹn 09:00 sẽ đợi tới 16:00 giờ Việt Nam mới chạy, và video ra lệch 7 tiếng so với
  ý người đặt lịch. Dockerfile đã set sẵn `ENV TZ`; chạy ngoài Docker thì tự khai trong
  `.env`.
