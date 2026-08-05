# Thang sửa lỗi — job không đứt quãng vì lỗi chất lượng

**Ngày:** 2026-08-05 · **Trạng thái:** đã duyệt, chờ lên kế hoạch triển khai

## Bối cảnh

Job `job_msfscs9i8d955b8d` (lịch #1, "THỜI SỰ · 08.05.2026") chết ở bước `checking`
với đúng một lỗi:

```
Layout ✗ t=0.38-4s (31 samples) content_overlap span.pill inside #sc0-k "BẢN TIN"
```

Nguyên nhân: LLM trả về `head` cho cảnh intro dài 49 ký tự — *"SJC: TỪ ĐỘC QUYỀN VÀNG
MIẾNG ĐẾN BÊ BỐI CHẤN ĐỘNG"*. Ở `.intro-title` 150px trong khung `.stage` rộng 936px,
chuỗi đó chiếm 5-6 dòng. Khối nội dung cao hơn 1100px của `.stage`, mà `.scene` là
`position:absolute; inset:0; justify-content:center` nên phần thừa **tràn đều cả hai
đầu**. Phần tràn lên trên đẩy `.kicker#sc0-k` vượt mốc y=300 vào vùng `.topbar`
(`top: 96px`), đè lên `span.pill`.

LLM không làm sai hợp đồng: `plan.mjs` bảo nó *"head … tối đa ~70 ký tự"*, còn
`news.css` ghi chú *"150px keeps a 2-3 word title within the 936px stage"*. **Prompt và
CSS mâu thuẫn nhau**, và `validateChapters()` không kiểm độ dài `head` nên không cổng nào
chặn.

Đây là lỗi **thẩm mỹ**, không phải lỗi kỹ thuật: video vẫn render được, chỉ là chữ đè
nhau. Nhưng pipeline coi `check_failed` là chết, nên một lỗi thẩm mỹ giết một job đã tốn
75 giây ASR và một lần gọi LLM.

## Mục tiêu

1. Job không bao giờ chết vì lỗi *chất lượng* — luôn ra video, kèm cảnh báo nếu xấu
2. Lỗi *kỹ thuật* thật (thiếu file, audio hỏng, không render nổi) vẫn fail rõ ràng
3. Sửa tất định trước, LLM sau — LLM chỉ vào cuộc khi code đã hết cách
4. Mọi lần tự sửa đều để lại dấu vết để người đọc lại và đẩy dần xuống tầng tất định

## Phạm vi

**Trong phạm vi**

- Phân loại findings của `check` thành *chặn cứng* và *chất lượng*
- Thang sửa 4 bậc ở bước `checking` (`src/repair.mjs` mới)
- Bậc thang cỡ chữ tất định trong `build.mjs` cho `.intro-title` và `.headline`
- Kiểm độ dài `head` theo `kind` trong `validateChapters()` + sửa prompt tương ứng
- Nhật ký sửa: `repair.json` + field `repairs` trong status + badge trên UI
- Phân loại lại toàn bộ `error.code` theo hướng "không đứt quãng"

**Ngoài phạm vi**

- Hàng đợi bền / chuyển job store sang PostgreSQL — hạng mục riêng, đã bàn, chưa làm
- Đẩy render lên cloud (`hyperframes cloud render`) — đã park
- ETA hàng đợi và cảnh báo lịch chồng giờ — làm sau, thuần UI
- Để Claude Code tự sửa file trong `templates/` — **cấm**, xem mục Ranh giới

---

## 1. Nguyên tắc

**"Không đứt quãng" đạt được chủ yếu không bằng LLM.** Phần lớn giá trị nằm ở việc thôi
coi lỗi layout là chí mạng. LLM là bậc áp chót của thang, không phải giải pháp chính.

**Sửa tất định trước, đoán sau.** Mỗi bậc chỉ chạy khi bậc trên hết đường. Bậc càng dưới
càng đắt, càng chậm, càng khó tái lập.

**LLM chỉ sửa dữ liệu, không sửa code.** Nó nhận JSON và trả JSON, luôn đi qua
`validateChapters()`. Không ghi file, không chạm `templates/`.

**Thang phải tự làm mình ngắn đi.** Nhật ký sửa tồn tại để mỗi tuần nhìn lại: lỗi nào
lặp lại thì viết luật tất định cho nó ở bậc 0 hoặc bậc 1. Thang dùng càng ít càng tốt.

## 2. Phân loại findings

`hyperframes check --json` (đã xác nhận có ở v0.7.86) trả findings có cấu trúc. Chia
làm hai nhóm:

| Nhóm | Gồm | Xử lý |
|---|---|---|
| **Chặn cứng** | Lint ở mức `error`; mọi finding thuộc mục `Runtime`; thiếu asset | Fail thật, `code: "check_failed"`, người sửa |
| **Chất lượng** | Mục `Layout` (`content_overlap`, tràn khung…), `Contrast`, caption zone, `Motion` | Vào thang sửa; hết thang thì render kèm cảnh báo |

Mọi mã chưa biết mặc định xếp vào **chất lượng** — an toàn hơn cho mục tiêu "không đứt
quãng", và nhật ký sửa sẽ lộ ra nếu phân loại sai.

Việc đầu tiên lúc triển khai: chạy `npx hyperframes@0.7.86 check --json` trên
`work/job_msfscs9i8d955b8d/project/` để chốt tên trường thật của JSON (`severity`,
`code`, `section`, selector, khoảng thời gian) trước khi viết bộ phân loại.

Đồng thời bỏ lệnh `npx hyperframes lint` chạy riêng trong `pipeline.mjs`: `check` đã
chạy lint bên trong, gọi thêm một lần là thừa.

## 3. Thang sửa

### Bậc 0 — Phòng ngừa (tất định, trước cả `check`)

Chạy ở bước `planning` và `building`, không phải một phần của thang, nhưng là lý do phần
lớn bản tin không bao giờ chạm tới bậc 1.

**3.1. `validateChapters()` kiểm độ dài `head` theo `kind`**

| kind | Trần `head` (ký tự) |
|---|---|
| `intro` | 28 |
| `divider` | 40 |
| `headline`, `story`, `image`, `chart`, `tiles` | 60 |
| `quote` | 120 |
| `stat` (`label`) | 40 |

Vi phạm là lỗi schema → rơi vào vòng retry 3 lần đã có sẵn trong `plan.mjs` → hỏng tiếp
thì `fallbackChapters()`. Không thêm cơ chế mới nào.

**3.2. Prompt khớp lại với CSS**

`plan.mjs` dòng *"head viết HOA hoặc Title Case, ngắn gọn, tối đa ~70 ký tự"* tách thành
trần riêng theo `kind`, đúng bảng trên. Nêu rõ intro là tiêu đề lớn nhất nên phải ngắn
nhất.

**3.3. Bậc thang cỡ chữ trong `build.mjs`**

Cùng thủ pháp đã dùng cho `stat` (`vlen >= 8 ? "xs" : vlen >= 6 ? "sm" : …`):

| Phần tử | Mặc định | Ngưỡng |
|---|---|---|
| `.intro-title` | 150px | ≥28 ký tự → 120px · ≥40 → 96px · ≥60 → 76px |
| `.headline` | 100px | ≥60 ký tự → 84px · ≥90 → 68px |

Đặt thành class phụ trong `news.css` (`.intro-title.sm`, `.intro-title.xs`, …), không
sinh style inline. Các con số là điểm khởi đầu; chốt lại bằng cách chạy `check` trên
tiêu đề dài thật.

Bậc 3.3 là lớp bảo hiểm cuối của tầng tất định: đúng kể cả khi LLM trả về gì đi nữa.

### Bậc 1 — Sửa tất định theo findings (không LLM)

Đọc findings, tra bảng ánh xạ lỗi → hành động, áp dụng, build lại, check lại.

Bảng khởi đầu:

| Finding | Hành động |
|---|---|
| `content_overlap` mà một bên nằm trong `.scene` | Hạ một bậc cỡ chữ cho đúng scene đó |

Trần: **2 vòng**. Hết bậc cỡ chữ hoặc hết vòng → xuống bậc 2.

**Cách áp dụng — không vá HTML đã sinh.** Bậc 1 ghi ra file đè cỡ chữ
`work/<job_id>/size-overrides.json` dạng `{"sc0": "sm", "sc3": "xs"}`, rồi **chạy lại
`build.mjs`** với cờ mới `--size-overrides <path>`. `build.mjs` vẫn là nơi duy nhất sinh
markup; thang sửa chỉ đưa thêm đầu vào cho nó. Vá thẳng `index.html` đã sinh sẽ khiến
bản dựng lại từ cùng input không còn khớp với video đã xuất.

Mọi hành động ở bậc này là hàm thuần: cùng findings vào, cùng thay đổi ra. Tái lập 100%.

Bảng này cố tình bắt đầu nhỏ. Nhật ký sửa sẽ chỉ ra nên thêm dòng nào.

### Bậc 2 — Claude Code sửa nội dung

Chỉ chạy khi bậc 1 hết đường. Dùng lại đúng khuôn `plan.mjs` đang dùng — đã chứng minh
chạy được với token trên VPS.

**Hợp đồng:**

- Vào: findings JSON + `chapters.src.json` hiện tại, qua stdin
- Ra: `chapters.src.json` mới, qua stdout, `-p --output-format json`
- **Không được ghi file nào.** Không truyền đường dẫn ghi, không cấp quyền sửa
  `templates/`
- Output đi qua `validateChapters()` y hệt bước planning — sai schema thì coi như vòng
  đó thất bại
- **Chỉ được sửa `head`, `sub`, `kicker`.** Cấm đổi số cảnh, cấm đổi `start`, cấm đổi
  `kind`, cấm đổi `img`. Kiểm bằng code sau khi nhận, không tin lời hứa trong prompt —
  đổi `start` là caption trôi khỏi giọng đọc, đúng cái bẫy LEAD/TAIL trong CLAUDE.md
- Trần: **2 vòng**, mỗi vòng có timeout như `plan.mjs`

Sau mỗi vòng: `mkchapters` → `build` → `check` lại.

### Bậc 3 — Sàn an toàn

Vẫn còn finding *chất lượng* → **vẫn render**. Ghi `addWarning(jobId, "quality_degraded",
…)` kèm số findings còn lại, đính findings vào artifacts. Job kết thúc `done`.

Job không bao giờ chết vì lỗi chất lượng. Đây là điều khoản định nghĩa "không đứt quãng".

### Chi phí trần

Tối đa 4 lần `check` thêm (2 ở bậc 1, 2 ở bậc 2), mỗi lần mở một phiên browser ~30-60
giây, cộng tối đa 2 lần gọi LLM. Vài phút, so với ~40 phút render là chấp nhận được.

## 4. Nhật ký sửa

Không có phần này thì thang sửa là nợ kỹ thuật: LLM âm thầm vá, `news.css` không ai sửa,
và template mục ruỗng cho tới ngày gặp ca vá không nổi.

**Ghi ra hai chỗ:**

- `work/<job_id>/repair.json` — findings gốc, từng bước can thiệp, findings còn lại
- Field `repairs` trong `status.json`: mảng `{ rung, finding_code, action, ok }`

**Hiện ra UI:** badge trên dòng job khi `repairs` không rỗng, phân biệt "đã tự sửa
(tất định)" với "đã tự sửa (LLM)" với "còn lỗi chất lượng".

**Quy trình người:** định kỳ đọc nhật ký. Finding nào lặp lại thì viết luật cho nó ở bậc
1, hoặc chặn từ bậc 0. Mục tiêu là số lần chạm bậc 2 giảm dần về 0.

## 5. Ranh giới

**Claude Code không được chạm file trong `templates/`.** Nó nhận JSON, trả JSON, hết
chuyện. Sửa `news.css` / `build.mjs` là việc của người và của git — để agent tự sửa code
trên máy chạy thật thì vài tháng nữa không ai giải thích nổi template và không tái lập
được bản tin cũ.

Ranh giới này thực thi bằng thiết kế chứ không bằng lời dặn: bậc 2 chỉ có một đường vào
(stdin JSON) và một đường ra (stdout JSON).

## 6. Phân loại lại `error.code`

| Mã | Xử lý |
|---|---|
| `check_failed` | Thang 4 bậc. Chỉ còn fail khi có finding **chặn cứng** |
| `render_failed` | Retry tất định 1 lần (đã `retryable`), không LLM |
| `lint_failed` | Lint mức `error` → chặn cứng. Không còn gọi lint riêng |
| `bad_input` | Fail thật — thiếu storyboard hoặc thiếu file giọng đọc |
| `asr_empty` | Fail thật — audio hỏng, LLM không cứu được |
| `align_failed` | Fail thật — kịch bản không khớp giọng đọc, dữ liệu vào sai |
| `timeout`, `interrupted` | Việc của hàng đợi, hạng mục riêng |

## 7. Thay đổi theo file

| File | Thay đổi |
|---|---|
| `src/repair.mjs` | **Mới.** Phân loại findings, bảng ánh xạ bậc 1, hợp đồng bậc 2, điều phối thang |
| `src/pipeline.mjs` | Bước `checking` gọi thang thay vì fail thẳng; bỏ lệnh `lint` riêng; ghi `repairs` |
| `src/plan.mjs` | Trần độ dài `head` theo `kind` trong `validateChapters()`; sửa prompt |
| `src/store.mjs` | Field `repairs` trong status |
| `src/ui.mjs` | Badge trạng thái sửa |
| `templates/vn-news-vertical/build.mjs` | Bậc thang cỡ chữ `.intro-title`, `.headline`; thêm cờ `--size-overrides` cho bậc 1 |
| `templates/vn-news-vertical/news.css` | Class phụ `.sm` / `.xs` cho hai phần tử trên |
| `CLAUDE.md` | Sửa nguyên tắc "Chỉ một bước dùng LLM" — xem mục 9 |

## 8. Kiểm thử

`test/` hiện chỉ có `scheduler`, `schedule`, `schedule-validate` — không test nào chạm
`plan.mjs` hay bước checking. Thêm `test/repair.test.mjs`:

- Bộ phân loại: finding chặn cứng → fail; finding chất lượng → vào thang; mã lạ → chất
  lượng
- Bảng ánh xạ bậc 1 là hàm thuần: cùng findings cho cùng kết quả
- Thứ tự thang: bậc 2 không được gọi khi bậc 1 còn đường
- Trần vòng lặp: bậc 1 tối đa 2, bậc 2 tối đa 2
- Bậc 3 luôn kết thúc `done`, không bao giờ `failed`, khi chỉ còn lỗi chất lượng
- **Kiểm output bậc 2**: chapters có số cảnh khác, `start` khác, hoặc `kind` khác so với
  bản gốc → từ chối

Thêm vào `test/plan.test.mjs` (mới): `validateChapters()` từ chối `head` quá trần theo
từng `kind`.

Bậc 2 phải test bằng stub `claude`, không gọi LLM thật trong test.

## 9. Đánh đổi đã chấp nhận

**Mất tính tất định khi bậc 2 chạy.** Cùng một storyboard, hai lần chạy có thể ra hai
video khác nhau. Đây là cái giá của "không đứt quãng", chủ repo đã chọn có ý thức
(2026-08-05). Bậc 0 và bậc 1 tồn tại để bậc 2 hiếm khi phải chạy.

**CLAUDE.md phải sửa.** Dòng *"Chỉ một bước dùng LLM"* không còn đúng. Thay bằng: *hai
bước — bước thứ hai chỉ chạy khi sửa tất định đã thất bại, chỉ được sửa dữ liệu, luôn
đi qua schema, luôn để lại nhật ký.* Không sửa dòng này thì người hoặc agent đọc file
sau sẽ làm ngược lại thiết kế.

## 10. Việc riêng, không thuộc thang sửa

`templates/vn-news-vertical/build.mjs` nạp GSAP từ `https://cdn.jsdelivr.net` — **fetch
mạng lúc render**, trái quy tắc "Render tất định" trong CLAUDE.md. Chạy được vì máy
render có mạng, nhưng là rủi ro thật và sẽ thành vấn đề nếu đẩy render lên cloud. Nên
vendor GSAP vào `assets/`. Ghi lại ở đây để không quên; không nằm trong phạm vi spec này.
