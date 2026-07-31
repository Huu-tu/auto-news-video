# PROMPT MẪU — tái tạo video bản tin trên máy bất kỳ

## Cách không bao giờ mất template (làm 1 lần)

⚠️ LƯU Ý: repo hyperframes **git-ignore cả `templates/` lẫn `videos/`**, và `origin` trỏ về
repo mã nguồn mở của HeyGen — KHÔNG dùng nơi này để lưu cá nhân được. Dùng 1 trong 3 cách:

1. **Zip (đơn giản nhất):** `zip -r ~/vn-news-vertical.zip templates/vn-news-vertical` (~20KB)
   — cất vào Google Drive / Dropbox / USB. Máy mới: giải nén, làm theo `README.md`.
2. **Repo riêng của bạn:** tạo 1 git repo cá nhân, copy thư mục `vn-news-vertical/` vào,
   commit + push. Máy mới `git clone` là có lại.
3. **Gist / note:** 10 file đều là text, dán vào 1 GitHub Gist private cũng được.

Toàn bộ design + generator + hướng dẫn nằm trong thư mục `templates/vn-news-vertical/`
(10 file, ~52KB).

---

## Prompt dán cho Claude Code (mỗi video mới)

**Cách nhanh nhất — gõ `/bantin`** (lệnh đã cài sẵn ở `~/.claude/commands/bantin.md`, dùng được
ở mọi project). Thêm tên project nếu muốn: `/bantin bantin-31-07`. Lệnh này đã gói sẵn toàn bộ
quy trình dưới đây, kể cả bước audit ASR bắt buộc.

Nếu ở máy khác chưa có lệnh đó, dán prompt sau:

> Tôi vừa bỏ file giọng đọc (và storyboard `prompts.md` + thư mục `image/` nếu là tin tài chính)
> vào thư mục `prompts ` — **tên thư mục có dấu cách ở cuối**, nhớ quote khi dùng shell.
> Kiểm tra mtime từng file trước: brief mới đến bằng cách THAY nội dung thư mục đó, file cũ
> hơn lần dựng trước là đồ thừa, bỏ qua.
> Hãy dùng template `templates/vn-news-vertical/` để dựng video bản tin dọc 9:16
> (chỉ chữ + đồ họa, không footage người thật), theo đúng quy trình trong
> `templates/vn-news-vertical/README.md`. Đọc mục "Thông số dựng" trong `prompts.md` như spec
> (ngày topbar = ngày PHÁT bản tin, không phải hôm nay; thương hiệu trung lập, không mạo danh
> báo/đài có thật). Output vào `videos/<tên-project>/`:
>
> 1. Cài `static-ffmpeg` + `faster-whisper` nếu máy chưa có; symlink ffmpeg/ffprobe vào `~/.local/bin`.
> 2. Chạy `transcribe.py` để lấy `transcript.json` (word timestamp, tiếng Việt).
> 3. Đọc transcript, phân tích cấu trúc (mấy tin, mốc thời gian từng tin),
>    trình bày cho tôi duyệt, rồi soạn `chapters.json`.
> 4. Tùy chọn: tạo `fixes.json` sửa lỗi nhận dạng tên riêng.
> 5. Chạy `build.mjs` với `--brand`/`--brand-sub`/`--date` phù hợp.
> 6. `npx hyperframes lint` + `check` (phải sạch lỗi), rồi `render --workers 4`.
> 7. Trích vài frame kiểm chứng caption không tràn trước khi báo hoàn thành.
>
> Lưu ý: transcribe trên CPU dùng **faster-whisper** (KHÔNG dùng whisper.cpp — chậm ~44× realtime).
> Caption phải cắt ngắn theo word timestamp (đã có sẵn trong `build.mjs`).

---

## Nếu muốn AI tự tạo lại template từ đầu (khi mất cả repo)

> Dựng cho tôi một template HyperFrames video bản tin tiếng Việt dọc 9:16:
> nền gradient navy-đen (#0a0d12 → #1a2434), thanh "BẢN TIN" pill đỏ (#d21422) + ngày ở góc trên,
> vùng giữa hiển thị headline lớn (Inter 800) + lower-third địa danh chấm đỏ + phụ đề xám,
> thẻ headline montage có số thứ tự mờ (01/02/03) + pill danh mục,
> caption trắng khớp giọng ở dải dưới (nền gradient mờ), progress bar đỏ mảnh ở đáy.
> Sinh composition bằng script Node từ transcript faster-whisper (cắt caption theo word timestamp,
> tối đa ~64 ký tự/cue) + chapters.json (kind: intro|divider|headline|story). Audio là `<audio>`
> con trực tiếp của root. Phải qua `npx hyperframes lint` + `check` sạch lỗi.
