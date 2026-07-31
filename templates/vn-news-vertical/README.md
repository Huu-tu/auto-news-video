# Template: VN News Vertical (bản tin dọc 9:16)

Template dựng video **bản tin tiếng Việt** từ 1 file giọng đọc: dọc 1080×1920, nền
navy-đen, thanh "BẢN TIN" đỏ, headline + lower-third + caption khớp giọng + progress bar.
Toàn bộ hình là chữ/đồ họa — không footage người thật.

Template nằm ở `templates/vn-news-vertical/`; mỗi video dựng ra là một project riêng trong
`videos/<tên-project>/`, bản render nằm ở `videos/<tên-project>/renders/`.

## Bộ template gồm

| File | Vai trò |
|---|---|
| `news.css` | **Design system** — màu, font, layout, spacing. Sửa file này để đổi giao diện. |
| `build.mjs` | Generator: transcript + chapters + audio → `index.html`. |
| `transcribe.py` | Audio → `transcript.json` (word timestamp) bằng faster-whisper. |
| `cut_audio.py` | Cắt đoạn thừa khỏi giọng đọc (vd **quảng cáo do nhà cung cấp TTS chèn**) và dời timestamp transcript theo. |
| `align_script.py` | Có kịch bản gốc → thay text ASR bằng kịch bản, giữ nguyên timing (caption đúng 100%). |
| `mkchapters.mjs` | `chapters.src.json` (đánh theo **dòng kịch bản**) + transcript → `chapters.json` (theo **giây**). |
| `chapters.example.json` | Mẫu bản đồ cảnh (bạn điền theo nội dung mỗi video). |
| `fixes.example.json` | Mẫu bảng sửa lỗi ASR (tùy chọn). |

## Yêu cầu cài 1 lần (mỗi máy mới)

```bash
pip install --user static-ffmpeg faster-whisper      # ffmpeg + engine transcribe
python3 -c "import static_ffmpeg.run as r; print(r.get_or_fetch_platform_executables_else_raise())"
# symlink ffmpeg/ffprobe vào ~/.local/bin (đã có trên PATH), rồi:
```

Node ≥ 18 (có sẵn) và `npx hyperframes` (tự tải khi chạy) là đủ cho build/lint/check/render.

## Quy trình dựng 1 video mới

```bash
# 0) tạo project
npx hyperframes init videos/my-news --example blank --non-interactive
cp templates/vn-news-vertical/* videos/my-news/   # tiện tay, hoặc trỏ path trực tiếp

# 1) transcribe giọng đọc  ->  transcript.json (+ .jsonl incremental)
python3 templates/vn-news-vertical/transcribe.py \
        <audio.mp3> videos/my-news/transcript.json large-v3 vi

# 1b) NGHE/SOI LẠI transcript trước khi dựng — bắt buộc:
#     - so `duration` với tổng thời lượng segment: chênh nhiều = ASR bỏ sót đoạn nào đó.
#     - khoảng trống > ~3s giữa 2 segment là dấu hiệu ASR nuốt mất tiếng nói.
#       Cắt riêng đoạn đó ra và transcribe lại với vad_filter=False để xem là gì.
#       (TTS miễn phí hay chèn QUẢNG CÁO vào giữa file — VAD của whisper bỏ qua nó,
#        nên nó không có trong transcript nhưng VẪN NẰM TRONG AUDIO.)
#     - có đoạn thừa thì khai vào cuts.json rồi:
python3 .../cut_audio.py <audio.mp3> cuts.json transcript.json vo-cut.mp3 transcript-cut.json

# 1c) (nên làm) có kịch bản gốc → caption đúng 100%:
python3 .../align_script.py transcript-cut.json script.txt transcript.json 2.6 2.4
#     2 số cuối = giây chèn thêm đầu/cuối cho thẻ mở đầu và thẻ kết; nhớ pad audio khớp:
#     ffmpeg -i vo-cut.mp3 -af "adelay=2600|2600,apad=pad_dur=2.4" ... vo-final.mp3

# 2) soạn chapters.src.json (mỗi cảnh gắn với 1 DÒNG kịch bản, không phải giây), rồi:
node .../mkchapters.mjs chapters.src.json transcript.json chapters.json
#    tùy chọn: tạo fixes.json để sửa lỗi nhận dạng (khi không dùng align_script.py).

# 3) build composition
node templates/vn-news-vertical/build.mjs \
     --out videos/my-news --audio <audio.mp3> \
     --transcript videos/my-news/transcript.json \
     --chapters videos/my-news/chapters.json \
     --brand "BẢN TIN" --brand-sub "TÀI CHÍNH" --date "Sáng 25 · 07"

# 4) kiểm tra + render
cd videos/my-news && npx hyperframes lint && npx hyperframes check
npx hyperframes render --workers 4     # ~20 phút cho video ~10 phút trên CPU 4 nhân
```

## chapters.json — các loại cảnh (`kind`)

- `intro` — thẻ mở đầu (dùng `kicker`, `head`, `sub`). Tiêu đề dài sẽ tự wrap 2-3 dòng.
- `divider` — thẻ ngăn ("NHỮNG TIN CHÍNH", "CẢM ƠN…") (dùng `head`).
- `headline` — thẻ headline montage đầu bản tin (dùng `idx`, `cat`, `head`, `sub`).
- `story` — thẻ tin chi tiết, có lower-third địa danh (dùng `cat`, `head`, `sub`).
- `stat` — **số liệu lớn** với hiệu ứng count-up (dùng `cat`, `value`, `unit`, `label`).
  `value` là số thuần (vd `"6.255"`, `"74,8"`) để đếm chạy; có chữ/khoảng thì hiện tĩnh.
- `chart` — **biểu đồ cột động** (dùng `cat`, `head`, `sub`, `bars`). Mỗi bar:
  `{ label, value, pct (0-100), hi?: true (cột đỏ nhấn), trend?: "up" (cột xanh) }`.
- `image` — **thẻ ảnh** (dùng `img`, `cat`, `head`, `sub?`, `tag?`). `img` là đường dẫn
  ảnh **tính từ thư mục bạn chạy `build.mjs`**; ảnh được copy vào `assets/img/`.
  Ảnh có Ken Burns zoom chậm suốt cảnh. `tag` là chip đỏ nhấn từ khóa đè lên ảnh.
  Ảnh **đồ họa/biểu đồ** (không được cắt xén) thì thêm `"fit": "contain"` + `"ratio": <w/h>`
  — khi đó bỏ Ken Burns. Ảnh chụp thường để mặc định (`cover`, khung 16/9).
- `tiles` — **lưới ô số liệu** 2 cột (dùng `cat`, `head?`, `tiles`, `foot?`). Mỗi ô:
  `{ value, label, note? }`. Dùng thay cho việc dán ảnh chụp bảng số liệu — chữ trong
  ảnh chụp gần như không đọc được ở khổ dọc 1080. `foot` để ghi nguồn số liệu.
- `quote` — **trích dẫn lớn** (dùng `head` = câu nói, `sub` = tên · chức danh).
- `keys` — **từ khóa nhấn mạnh** xếp dọc, hiện lần lượt (dùng `cat`, `keys: [...]`, `sub?`).
  Từ khóa >16 ký tự sẽ tự thu nhỏ cỡ chữ; nên giữ mỗi từ khóa ngắn.

`start` (giây) là **mốc bắt đầu** cảnh; mỗi cảnh chạy tới cảnh kế tiếp. Caption tự sinh
từ transcript, không cần khai trong chapters.

> **Mẹo transcript chính xác:** nếu bạn đã có kịch bản gốc (như storyboard), thay text ASR
> bằng câu đúng rồi phân bổ lại word-timing đều trong mỗi segment — đó chính là việc
> `align_script.py` làm (bước 1c ở trên) → caption đúng 100%.

## Đổi giao diện nhanh (sửa `news.css`)

- Màu nhấn đỏ: đổi mọi `#d21422`.
- Nền: `.bg` (gradient), `.vignette`.
- Cỡ chữ: `.headline`, `.subhead`, `.cap`, `.intro-title`.
- Vị trí thanh caption: `.caprail`, `.caprail-bg`.

## Không mất template khi đổi máy

⚠️ Thư mục `templates/` **không** được git theo dõi (bị loại trong `.git/info/exclude`, vì
`origin` là repo mã nguồn mở của HeyGen — không dùng để lưu đồ cá nhân). `git clone` sẽ
KHÔNG mang template này theo. Xem `PROMPT.md` để biết cách sao lưu và lấy lại trên máy mới.
