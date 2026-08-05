# Thang sửa lỗi — Kế hoạch triển khai

> **Cho agent thực thi:** SUB-SKILL BẮT BUỘC: dùng superpowers:subagent-driven-development (khuyến nghị) hoặc superpowers:executing-plans để làm từng task. Các bước dùng checkbox (`- [ ]`) để theo dõi.

**Mục tiêu:** Job không bao giờ chết vì lỗi chất lượng (layout, contrast) — sửa tất định trước, Claude Code sau, hết cách thì vẫn render kèm cảnh báo.

**Kiến trúc:** Bước `checking` trong `pipeline.mjs` gọi một thang 4 bậc trong `src/repair.mjs` mới. Bậc 0 chặn từ schema và bậc thang cỡ chữ tất định; bậc 1 sửa bằng luật cứng rồi build lại; bậc 2 gọi `claude -p` sửa **nội dung** với hợp đồng kiểm bằng code; bậc 3 render bất chấp. Mọi can thiệp ghi vào `repair.json` và field `repairs` trong status.

**Tech stack:** Node 22 ESM thuần, `node --test`, `node:assert/strict`. Không thêm dependency nào.

**Spec:** [docs/superpowers/specs/2026-08-05-thang-sua-loi-thiet-ke.md](../specs/2026-08-05-thang-sua-loi-thiet-ke.md)

## Ràng buộc toàn cục

- **KHÔNG chạy lệnh git làm đổi trạng thái repo.** CLAUDE.md cấm tuyệt đối, và điều luật đó đè lên bước "commit" viết sẵn trong mọi quy trình tự động. Mỗi task kết thúc bằng *dừng lại và báo đường dẫn file đã sửa*; chủ repo tự commit. Lệnh `git status` / `log` / `diff` thì được.
- **Không thêm dependency.** Repo hiện chỉ có `hono`, `@hono/node-server`, `postgres`.
- **Không thêm framework UI.** Trang quản lý là HTML render phía server.
- Chạy test: `npm test` (tức `node --env-file-if-exists=.env --test "test/**/*.test.mjs"`).
- Chạy một file test: `node --test test/repair.test.mjs`.
- Ngôn ngữ log, thông báo lỗi, comment: **tiếng Việt**, theo đúng phần còn lại của repo.
- `HYPERFRAMES_VERSION` mặc định `0.7.86`. Hình dạng JSON dưới đây đã xác minh thực tế trên đúng bản này.
- **Bậc 2 không bao giờ được gọi LLM thật trong test.** Luôn tiêm hàm giả.

## Hình dạng `hyperframes check --json` (đã xác minh)

Cấp cao nhất: `{ ok, strict, lint, runtime, layout, motion, contrast, snapshots, _meta }`.

Mỗi mục kiểm tra: `{ ok, errorCount, warningCount, infoCount, findings: [...] }`.
`snapshots` và `_meta` **không** có `findings`.

Một finding của `layout` (nguyên văn, đã rút gọn):

```json
{
  "code": "content_overlap",
  "severity": "error",
  "time": 0,
  "selector": "span.pill",
  "message": "Two text blocks overlap and may render unreadable.",
  "containerSelector": "#sc0-k",
  "text": "BẢN TIN",
  "sourceFile": "index.html",
  "firstSeen": 0,
  "lastSeen": 3.875,
  "occurrences": 40
}
```

Một finding của `contrast`: `{ "code": "contrast_aa_failure", "severity": "error", "selector": "#sc0-k", "ratio": 1.82, "requiredRatio": 3, "suggestedColor": "rgb(255,170,176)", ... }`.

Một finding của `lint`: `{ "code": "studio_missing_editable_id", "severity": "warning", "selector": "[data-composition-id]", ... }`.

`severity` nhận `"error" | "warning" | "info"`. Chỉ `severity === "error"` mới được thang sửa quan tâm.

## Cấu trúc file

| File | Trách nhiệm |
|---|---|
| `src/repair.mjs` | **Mới.** Phân loại findings, luật sửa bậc 1, hợp đồng bậc 2, điều phối thang. Toàn bộ hàm thuần trừ `runRepairLadder`, và hàm đó nhận mọi tác dụng phụ qua tham số |
| `test/repair.test.mjs` | **Mới.** Test cho `src/repair.mjs` |
| `test/plan.test.mjs` | **Mới.** Test cho trần độ dài `head` |
| `src/plan.mjs` | Thêm `HEAD_MAX`, kiểm trong `validateChapters`, sửa prompt, sửa `fallbackChapters` |
| `src/pipeline.mjs` | Bước `checking` gọi thang; bỏ lệnh `lint` riêng; ghi `repairs` + `repair.json` |
| `src/ui.mjs` | Badge trạng thái sửa |
| `templates/vn-news-vertical/build.mjs` | Bậc thang cỡ chữ theo độ dài; cờ `--size-overrides` |
| `templates/vn-news-vertical/news.css` | Class `.len2` / `.len3` / `.len4` |
| `CLAUDE.md` | Sửa nguyên tắc "Chỉ một bước dùng LLM" |

**Thứ tự task:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Task 4-7 xây `src/repair.mjs` theo lớp; task 8 mới nối vào pipeline.

---

### Task 1: Trần độ dài `head` theo `kind`

Chặn từ gốc: LLM không được trả tiêu đề dài hơn mức `news.css` chịu nổi. Sai thì rơi vào vòng retry 3 lần đã có sẵn trong `planChapters`.

**Files:**
- Modify: `src/plan.mjs`
- Test: `test/plan.test.mjs` (tạo mới)

**Interfaces:**
- Produces: `HEAD_MAX` (object, export) — bảng tra `kind → số ký tự tối đa`. Task 2 dùng cùng bộ ngưỡng nhưng **không** import (template là module độc lập, chạy bằng `node build.mjs`); nếu đổi số ở đây phải đổi cả `INTRO_STEPS` / `HEAD_STEPS` ở Task 2.
- Produces: `validateChapters(cards, lineCount)` giữ nguyên chữ ký, chỉ thêm lỗi mới vào mảng `errors`.

- [ ] **Bước 1: Viết test thất bại**

Tạo `test/plan.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateChapters, fallbackChapters, HEAD_MAX } from "../src/plan.mjs";

const introCard = (head) => ({ line: "intro", kind: "intro", kicker: "ĐIỂM TIN NHANH", head, sub: "" });
const storyCard = (head) => ({ line: 0, kind: "story", cat: "THỜI SỰ", head, sub: "x" });

test("HEAD_MAX khai đủ ngưỡng cho các kind có head", () => {
  assert.equal(HEAD_MAX.intro, 28);
  assert.equal(HEAD_MAX.divider, 40);
  assert.equal(HEAD_MAX.story, 60);
  assert.equal(HEAD_MAX.quote, 120);
});

test("chặn head intro dài hơn 28 ký tự", () => {
  const head = "SJC: TỪ ĐỘC QUYỀN VÀNG MIẾNG ĐẾN BÊ BỐI CHẤN ĐỘNG";
  const { ok, errors } = validateChapters([introCard(head)], 1);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /head dài 49 ký tự, tối đa 28/.test(e)), true);
});

test("nhận head intro đúng 28 ký tự", () => {
  const head = "A".repeat(28);
  const { ok } = validateChapters([introCard(head)], 1);
  assert.equal(ok, true);
});

test("chặn head story dài hơn 60 ký tự", () => {
  const { ok, errors } = validateChapters([introCard("BẢN TIN"), storyCard("B".repeat(61))], 1);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /head dài 61 ký tự, tối đa 60/.test(e)), true);
});

test("chặn label của stat dài hơn 40 ký tự", () => {
  const card = { line: 0, kind: "stat", cat: "KINH TẾ", value: "6.255", unit: "tỷ", label: "C".repeat(41) };
  const { ok, errors } = validateChapters([introCard("BẢN TIN"), card], 1);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /label dài 41 ký tự, tối đa 40/.test(e)), true);
});

test("fallbackChapters tự nó phải qua được validateChapters", () => {
  const rows = [
    { text: "Giá vàng thế giới sáng nay tăng mạnh lên sát bốn nghìn một trăm đô la một ounce, mức cao nhất từ trước tới nay." },
    { text: "Đồng yên Nhật rơi xuống mức thấp nhất trong bốn mươi năm so với đô la Mỹ." },
  ];
  const cards = fallbackChapters(rows, { name: "BẢN TIN", sub: "THỜI SỰ", date: "" });
  const { ok, errors } = validateChapters(cards, rows.length);
  assert.equal(ok, true, `fallback không được tự vi phạm schema: ${errors.join("; ")}`);
});
```

- [ ] **Bước 2: Chạy test để chắc chắn nó fail**

Chạy: `node --test test/plan.test.mjs`
Kỳ vọng: FAIL — `HEAD_MAX` chưa được export (`assert.equal(undefined, 28)`).

- [ ] **Bước 3: Thêm `HEAD_MAX` và phần kiểm vào `validateChapters`**

Trong `src/plan.mjs`, ngay dưới `const KIND_ALIAS = ...` (dòng 16):

```js
// Trần độ dài head theo kind — khớp với bậc thang cỡ chữ trong
// templates/vn-news-vertical/build.mjs. Đổi số ở đây thì phải đổi cả bên đó.
export const HEAD_MAX = {
  intro: 28,
  divider: 40,
  headline: 60,
  story: 60,
  image: 60,
  chart: 60,
  tiles: 60,
  keys: 60,
  quote: 120,
};

const LABEL_MAX = 40;
```

Trong `validateChapters`, ngay sau vòng lặp kiểm field bắt buộc (sau dòng 47, trước phần kiểm `chart`/`tiles`/`keys`):

```js
    const cap = HEAD_MAX[c.kind];
    if (cap && typeof c.head === "string" && c.head.length > cap) {
      errors.push(`${at} (${c.kind}): head dài ${c.head.length} ký tự, tối đa ${cap}`);
    }
    if (c.kind === "stat" && typeof c.label === "string" && c.label.length > LABEL_MAX) {
      errors.push(`${at} (stat): label dài ${c.label.length} ký tự, tối đa ${LABEL_MAX}`);
    }
```

- [ ] **Bước 4: Sửa `fallbackChapters` cho khỏi tự vi phạm**

`fallbackChapters` đang cắt `head` ở 70 ký tự — vượt trần 60 của `story`. Trong `src/plan.mjs` dòng 78:

```js
    const head = r.text.split(/[,.]/)[0].slice(0, 70).trim();
```

đổi thành:

```js
    const head = r.text.split(/[,.]/)[0].slice(0, HEAD_MAX.story).trim();
```

- [ ] **Bước 5: Sửa prompt cho khớp trần mới**

Trong `buildPrompt`, thay dòng 131:

```js
- head viết HOA hoặc Title Case, ngắn gọn, tối đa ~70 ký tự.
```

bằng:

```js
- head viết HOA hoặc Title Case, NGẮN. Trần cứng theo kind, vượt là bị trả lại:
  intro 28 ký tự (đây là chữ to nhất màn hình — 3 từ là vừa)
  divider 40 · headline/story/image/chart/tiles/keys 60 · quote 120
  stat: label tối đa 40 ký tự.
```

- [ ] **Bước 6: Chạy lại toàn bộ test**

Chạy: `npm test`
Kỳ vọng: PASS toàn bộ, gồm 6 test mới trong `test/plan.test.mjs` và các test cũ của scheduler/schedule.

- [ ] **Bước 7: Dừng lại và báo**

Không commit. Báo cho chủ repo: đã sửa `src/plan.mjs`, tạo `test/plan.test.mjs`, và câu lệnh họ có thể tự chạy:

```
git add src/plan.mjs test/plan.test.mjs
```

---

### Task 2: Bậc thang cỡ chữ tất định

Lớp bảo hiểm cuối của tầng tất định: đúng kể cả khi LLM trả về gì, kể cả khi dùng `fallbackChapters`.

**Files:**
- Modify: `templates/vn-news-vertical/news.css`
- Modify: `templates/vn-news-vertical/build.mjs:125-145` (cảnh `intro`, `story`), và khối `kind === "image"` (~dòng 157-175)

**Interfaces:**
- Produces: hàm `lenClass(text, steps)` trong `build.mjs` — trả về chuỗi rỗng hoặc `" len2"` / `" len3"` / `" len4"`. Task 3 bọc hàm này lại thành `sizeClass(id, text, steps)`.
- Produces: hằng `INTRO_STEPS`, `HEAD_STEPS` trong `build.mjs`.

**Cảnh báo va chạm tên:** `.headline.sm` **đã tồn tại** trong `news.css:67` với nghĩa hoàn toàn khác — tiêu đề bên dưới thẻ ảnh, 74px. Không được tái sử dụng `.sm` / `.xs` cho bậc thang độ dài. Dùng `.len2` / `.len3` / `.len4`.

**Cảnh báo thứ tự CSS:** `.headline.len2` và `.headline.sm` cùng độ đặc hiệu (2 class). Luật nào viết sau thì thắng. Vì vậy **mọi luật `.len*` phải nằm ở cuối `news.css`**, sau `.headline.sm`, để cảnh ảnh có tiêu đề dài vẫn được thu nhỏ.

- [ ] **Bước 1: Thêm class bậc thang vào cuối `news.css`**

Chèn vào **cuối** `templates/vn-news-vertical/news.css` (sau mọi luật hiện có):

```css
      /* Bậc thang cỡ chữ theo độ dài tiêu đề. Phải nằm cuối file: .headline.len2
         và .headline.sm cùng độ đặc hiệu nên luật viết sau mới thắng. */
      .intro-title.len2 { font-size: 120px; }
      .intro-title.len3 { font-size: 96px; }
      .intro-title.len4 { font-size: 76px; }
      .headline.len2 { font-size: 84px; }
      .headline.len3 { font-size: 68px; }
      .headline.sm.len2 { font-size: 62px; }
      .headline.sm.len3 { font-size: 52px; }
```

- [ ] **Bước 2: Thêm hàm bậc thang vào `build.mjs`**

Trong `templates/vn-news-vertical/build.mjs`, ngay sau `const esc = ...` (dòng 55):

```js
// Bậc thang cỡ chữ: tiêu đề càng dài, class càng nhỏ. Ngưỡng khớp với HEAD_MAX
// trong src/plan.mjs — đổi bên đó thì đổi cả đây. Mảng xếp giảm dần, khớp đầu tiên thắng.
const INTRO_STEPS = [[60, "len4"], [40, "len3"], [28, "len2"]];
const HEAD_STEPS = [[90, "len3"], [60, "len2"]];

const lenClass = (text, steps) => {
  const n = String(text ?? "").length;
  for (const [min, cls] of steps) if (n >= min) return ` ${cls}`;
  return "";
};
```

- [ ] **Bước 3: Áp vào ba chỗ sinh markup**

Cảnh `intro` (dòng 132) — đổi:

```js
          <div class="intro-title" id="${id}-t">${esc(ch.head || BRAND)}</div>
```

thành:

```js
          <div class="intro-title${lenClass(ch.head || BRAND, INTRO_STEPS)}" id="${id}-t">${esc(ch.head || BRAND)}</div>
```

Cảnh `story` (dòng 143) — đổi:

```js
          <div class="headline" id="${id}-h">${esc(ch.head)}</div>
```

thành:

```js
          <div class="headline${lenClass(ch.head, HEAD_STEPS)}" id="${id}-h">${esc(ch.head)}</div>
```

Cảnh `image` (trong khối `kind === "image"`) — đổi:

```js
          ${ch.head ? `<div class="headline sm" id="${id}-h">${esc(ch.head)}</div>` : ""}
```

thành:

```js
          ${ch.head ? `<div class="headline sm${lenClass(ch.head, HEAD_STEPS)}" id="${id}-h">${esc(ch.head)}</div>` : ""}
```

- [ ] **Bước 4: Kiểm bằng mắt trên chuỗi thật**

Chạy trong thư mục repo:

```bash
node -e '
const INTRO_STEPS = [[60,"len4"],[40,"len3"],[28,"len2"]];
const lenClass = (t,s)=>{const n=String(t??"").length; for(const [m,c] of s) if(n>=m) return " "+c; return "";};
const head = "SJC: TỪ ĐỘC QUYỀN VÀNG MIẾNG ĐẾN BÊ BỐI CHẤN ĐỘNG";
console.log(head.length, JSON.stringify(lenClass(head, INTRO_STEPS)));
console.log(27, JSON.stringify(lenClass("A".repeat(27), INTRO_STEPS)));
console.log(28, JSON.stringify(lenClass("A".repeat(28), INTRO_STEPS)));
'
```

Kỳ vọng in ra:
```
49 " len3"
27 ""
28 " len2"
```

- [ ] **Bước 5: Chạy lại toàn bộ test**

Chạy: `npm test`
Kỳ vọng: PASS — task này không đụng module nào có test, chỉ để chắc không làm hỏng gì.

- [ ] **Bước 6: Dừng lại và báo**

Không commit. Báo file đã sửa: `templates/vn-news-vertical/news.css`, `templates/vn-news-vertical/build.mjs`.

---

### Task 3: Cờ `--size-overrides` cho `build.mjs`

Bậc 1 của thang sửa cần ép cỡ chữ cho một scene cụ thể mà **không vá HTML đã sinh** — `build.mjs` phải vẫn là nơi duy nhất sinh markup.

**Files:**
- Modify: `templates/vn-news-vertical/build.mjs`

**Interfaces:**
- Consumes: `lenClass`, `INTRO_STEPS`, `HEAD_STEPS` từ Task 2.
- Produces: hàm `sizeClass(sceneId, text, steps)` — thay thế mọi lời gọi `lenClass` trực tiếp trong phần sinh markup.
- Produces: hợp đồng CLI `--size-overrides <path>`, file JSON dạng `{"sc0": "len3", "sc4": "len2"}`. Task 5 và Task 7 sinh ra file này.

- [ ] **Bước 1: Đọc file đè, theo đúng khuôn `fixes.json` đã có**

Trong `build.mjs`, ngay sau khối đọc `fixes.json` (sau dòng 54, trước `const esc = ...`):

```js
// ---- optional: file đè cỡ chữ do thang sửa lỗi sinh ra { "sc0": "len3" } ----
let SIZE_OVERRIDES = {};
if (A["size-overrides"]) {
  try {
    SIZE_OVERRIDES = JSON.parse(readFileSync(resolve(A["size-overrides"]), "utf8"));
  } catch {
    /* không đọc được file đè — quay về bậc thang theo độ dài */
  }
}
```

- [ ] **Bước 2: Thêm `sizeClass` bọc ngoài `lenClass`**

Ngay sau định nghĩa `lenClass` (Task 2):

```js
// Đè thắng bậc thang tự động: thang sửa lỗi đã đo thực tế bằng hyperframes check,
// còn lenClass chỉ đoán theo số ký tự.
const sizeClass = (sceneId, text, steps) =>
  SIZE_OVERRIDES[sceneId] ? ` ${SIZE_OVERRIDES[sceneId]}` : lenClass(text, steps);
```

- [ ] **Bước 3: Đổi ba chỗ sinh markup sang `sizeClass`**

Cảnh `intro`:

```js
          <div class="intro-title${sizeClass(id, ch.head || BRAND, INTRO_STEPS)}" id="${id}-t">${esc(ch.head || BRAND)}</div>
```

Cảnh `story`:

```js
          <div class="headline${sizeClass(id, ch.head, HEAD_STEPS)}" id="${id}-h">${esc(ch.head)}</div>
```

Cảnh `image`:

```js
          ${ch.head ? `<div class="headline sm${sizeClass(id, ch.head, HEAD_STEPS)}" id="${id}-h">${esc(ch.head)}</div>` : ""}
```

- [ ] **Bước 4: Cập nhật khối chú thích Usage đầu file**

Trong khối comment dòng 6-10, thêm vào cuối danh sách tuỳ chọn:

```
//        [--kicker "ĐIỂM TIN NHANH"] [--fps 25] [--size-overrides <json>]
```

- [ ] **Bước 5: Kiểm bằng tay rằng đè thắng bậc thang**

```bash
node -e '
const SIZE_OVERRIDES = {"sc0":"len4"};
const INTRO_STEPS = [[60,"len4"],[40,"len3"],[28,"len2"]];
const lenClass = (t,s)=>{const n=String(t??"").length; for(const [m,c] of s) if(n>=m) return " "+c; return "";};
const sizeClass = (id,t,s)=> SIZE_OVERRIDES[id] ? " "+SIZE_OVERRIDES[id] : lenClass(t,s);
console.log(JSON.stringify(sizeClass("sc0","NGẮN",INTRO_STEPS)));
console.log(JSON.stringify(sizeClass("sc1","NGẮN",INTRO_STEPS)));
'
```

Kỳ vọng:
```
" len4"
""
```

- [ ] **Bước 6: Chạy lại toàn bộ test**

Chạy: `npm test` · Kỳ vọng: PASS.

- [ ] **Bước 7: Dừng lại và báo**

Không commit. Báo file đã sửa: `templates/vn-news-vertical/build.mjs`.

---

### Task 4: Phân loại findings

Lớp đầu tiên của `src/repair.mjs`: chia findings thành *chặn cứng* (fail thật) và *chất lượng* (vào thang sửa).

**Files:**
- Create: `src/repair.mjs`
- Test: `test/repair.test.mjs` (tạo mới)

**Interfaces:**
- Produces: `classifyFindings(report) → { blocking: Finding[], quality: Finding[] }`. Mỗi phần tử là finding gốc cộng thêm field `section` (chuỗi: `"lint"`, `"layout"`, …).
- Produces: `BLOCKING_SECTIONS` (mảng chuỗi, export) — Task 8 dùng để viết thông báo lỗi.

- [ ] **Bước 1: Viết test thất bại**

Tạo `test/repair.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFindings, BLOCKING_SECTIONS } from "../src/repair.mjs";

const report = (over = {}) => ({
  ok: false,
  strict: false,
  lint: { ok: true, errorCount: 0, findings: [] },
  runtime: { ok: true, errorCount: 0, findings: [] },
  layout: { ok: true, errorCount: 0, findings: [] },
  motion: { ok: true, errorCount: 0, findings: [] },
  contrast: { ok: true, errorCount: 0, findings: [] },
  snapshots: { enabled: false, files: [] },
  _meta: { version: "0.7.86" },
  ...over,
});

const overlap = {
  code: "content_overlap",
  severity: "error",
  selector: "span.pill",
  containerSelector: "#sc0-k",
  text: "BẢN TIN",
};

test("BLOCKING_SECTIONS đúng hai mục lint và runtime", () => {
  assert.deepEqual([...BLOCKING_SECTIONS].sort(), ["lint", "runtime"]);
});

test("content_overlap của layout là lỗi chất lượng", () => {
  const { blocking, quality } = classifyFindings(report({ layout: { findings: [overlap] } }));
  assert.equal(blocking.length, 0);
  assert.equal(quality.length, 1);
  assert.equal(quality[0].section, "layout");
  assert.equal(quality[0].code, "content_overlap");
});

test("lỗi runtime là chặn cứng", () => {
  const f = { code: "runtime_error", severity: "error", message: "boom" };
  const { blocking, quality } = classifyFindings(report({ runtime: { findings: [f] } }));
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].section, "runtime");
  assert.equal(quality.length, 0);
});

test("lint mức warning không phải lỗi, không vào nhóm nào", () => {
  const f = { code: "studio_missing_editable_id", severity: "warning" };
  const { blocking, quality } = classifyFindings(report({ lint: { findings: [f] } }));
  assert.equal(blocking.length, 0);
  assert.equal(quality.length, 0);
});

test("lint mức error là chặn cứng", () => {
  const f = { code: "broken_html", severity: "error" };
  const { blocking } = classifyFindings(report({ lint: { findings: [f] } }));
  assert.equal(blocking.length, 1);
});

test("mục lạ chưa biết mặc định xếp vào chất lượng", () => {
  const f = { code: "some_future_check", severity: "error" };
  const { blocking, quality } = classifyFindings(report({ caption: { findings: [f] } }));
  assert.equal(blocking.length, 0);
  assert.equal(quality.length, 1);
  assert.equal(quality[0].section, "caption");
});

test("bỏ qua snapshots và _meta vì không có mảng findings", () => {
  const r = classifyFindings(report());
  assert.equal(r.blocking.length, 0);
  assert.equal(r.quality.length, 0);
});

test("report rỗng hoặc null không làm nổ", () => {
  assert.deepEqual(classifyFindings(null), { blocking: [], quality: [] });
  assert.deepEqual(classifyFindings({}), { blocking: [], quality: [] });
});
```

- [ ] **Bước 2: Chạy test để chắc chắn nó fail**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: FAIL — `Cannot find module '../src/repair.mjs'`.

- [ ] **Bước 3: Viết `src/repair.mjs` tối thiểu**

```js
// Thang sửa lỗi chất lượng cho bước checking của pipeline.
// Bậc 1 sửa tất định, bậc 2 nhờ Claude Code sửa nội dung, bậc 3 render bất chấp.
// Xem docs/superpowers/specs/2026-08-05-thang-sua-loi-thiet-ke.md

// Lỗi ở hai mục này nghĩa là composition không render nổi — người phải sửa.
export const BLOCKING_SECTIONS = ["lint", "runtime"];

// Khoá cấp cao nhất của check --json không phải là mục kiểm tra.
const NOT_A_SECTION = new Set(["ok", "strict", "snapshots", "_meta"]);

export function classifyFindings(report) {
  const blocking = [];
  const quality = [];

  for (const [section, value] of Object.entries(report || {})) {
    if (NOT_A_SECTION.has(section)) continue;
    if (!value || !Array.isArray(value.findings)) continue;

    for (const f of value.findings) {
      // Chỉ error mới đáng xử lý; warning của lint đang có 7 cái mỗi lần chạy.
      if (f?.severity !== "error") continue;
      const tagged = { ...f, section };
      if (BLOCKING_SECTIONS.includes(section)) blocking.push(tagged);
      else quality.push(tagged); // mục lạ mặc định là chất lượng — nghiêng về không đứt quãng
    }
  }

  return { blocking, quality };
}
```

- [ ] **Bước 4: Chạy test cho chắc nó pass**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: PASS, 8 test.

- [ ] **Bước 5: Dừng lại và báo**

Không commit. Báo: tạo `src/repair.mjs` và `test/repair.test.mjs`.

---

### Task 5: Luật sửa bậc 1

Ánh xạ finding → hành động tất định. Bảng bắt đầu nhỏ, cố ý: chỉ `content_overlap`.

**Files:**
- Modify: `src/repair.mjs`
- Modify: `test/repair.test.mjs`

**Interfaces:**
- Consumes: `classifyFindings` từ Task 4.
- Produces: `sceneIdFrom(finding) → string | null` — rút `"sc0"` từ `containerSelector` `"#sc0-k"` hoặc từ `selector`.
- Produces: `SIZE_STEPS = ["len2", "len3", "len4"]` (export).
- Produces: `planDeterministicFix(qualityFindings, currentOverrides = {}) → { overrides, actions }`. `overrides` là object `{ sceneId: "len2" }` hợp nhất với đầu vào; `actions` là mảng `{ rung: 1, finding_code, scene, action }`. `actions` rỗng nghĩa là **bậc 1 hết đường** — Task 7 dùng đúng dấu hiệu này để xuống bậc 2.

- [ ] **Bước 1: Viết test thất bại**

Thêm vào `test/repair.test.mjs`:

```js
import { planDeterministicFix, sceneIdFrom, SIZE_STEPS } from "../src/repair.mjs";

const q = (over = {}) => ({
  code: "content_overlap",
  severity: "error",
  section: "layout",
  selector: "span.pill",
  containerSelector: "#sc0-k",
  ...over,
});

test("sceneIdFrom rút scene từ containerSelector", () => {
  assert.equal(sceneIdFrom(q()), "sc0");
});

test("sceneIdFrom rút scene từ selector khi containerSelector không có scene", () => {
  assert.equal(sceneIdFrom(q({ containerSelector: ".topbar", selector: "#sc12-h" })), "sc12");
});

test("sceneIdFrom trả null khi không bên nào là scene", () => {
  assert.equal(sceneIdFrom(q({ containerSelector: ".topbar", selector: "span.pill" })), null);
});

test("bậc 1 hạ một bậc cỡ chữ cho scene bị đè", () => {
  const { overrides, actions } = planDeterministicFix([q()]);
  assert.deepEqual(overrides, { sc0: "len2" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].rung, 1);
  assert.equal(actions[0].scene, "sc0");
  assert.equal(actions[0].finding_code, "content_overlap");
});

test("gọi lần hai thì hạ tiếp một bậc nữa", () => {
  const first = planDeterministicFix([q()]);
  const second = planDeterministicFix([q()], first.overrides);
  assert.deepEqual(second.overrides, { sc0: "len3" });
  assert.equal(second.actions.length, 1);
});

test("hết bậc thì không sinh hành động nào", () => {
  const { overrides, actions } = planDeterministicFix([q()], { sc0: SIZE_STEPS[SIZE_STEPS.length - 1] });
  assert.deepEqual(overrides, { sc0: "len4" });
  assert.equal(actions.length, 0, "actions rỗng là tín hiệu bậc 1 đã hết đường");
});

test("bỏ qua finding không có trong bảng ánh xạ", () => {
  const { actions } = planDeterministicFix([q({ code: "contrast_aa_failure" })]);
  assert.equal(actions.length, 0);
});

test("bỏ qua content_overlap không gắn với scene nào", () => {
  const { actions } = planDeterministicFix([q({ containerSelector: ".topbar", selector: "span.pill" })]);
  assert.equal(actions.length, 0);
});

test("không sửa object overrides được truyền vào", () => {
  const current = { sc0: "len2" };
  planDeterministicFix([q()], current);
  assert.deepEqual(current, { sc0: "len2" }, "phải trả bản sao, không đụng đầu vào");
});
```

- [ ] **Bước 2: Chạy test để chắc chắn nó fail**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: FAIL — `planDeterministicFix is not a function`.

- [ ] **Bước 3: Viết phần cài đặt**

Thêm vào cuối `src/repair.mjs`:

```js
// id scene do build.mjs sinh ra là sc0, sc1… và các con là sc0-k, sc0-t, sc0-h…
const SCENE_RE = /#(sc\d+)(?:-[a-z0-9]+)?/i;

export const SIZE_STEPS = ["len2", "len3", "len4"];

export function sceneIdFrom(finding) {
  for (const sel of [finding?.containerSelector, finding?.selector]) {
    if (typeof sel !== "string") continue;
    const m = sel.match(SCENE_RE);
    if (m) return m[1];
  }
  return null;
}

// Bảng ánh xạ cố ý bắt đầu nhỏ. Nhật ký sửa sẽ chỉ ra nên thêm dòng nào.
export function planDeterministicFix(qualityFindings, currentOverrides = {}) {
  const overrides = { ...currentOverrides };
  const actions = [];

  for (const f of qualityFindings || []) {
    if (f?.code !== "content_overlap") continue;

    const scene = sceneIdFrom(f);
    if (!scene) continue;

    const at = SIZE_STEPS.indexOf(overrides[scene]);
    if (at >= SIZE_STEPS.length - 1) continue; // đã ở bậc nhỏ nhất

    overrides[scene] = SIZE_STEPS[at + 1]; // indexOf trả -1 khi chưa đặt → bậc đầu tiên
    actions.push({ rung: 1, finding_code: f.code, scene, action: `size:${overrides[scene]}` });
  }

  return { overrides, actions };
}
```

- [ ] **Bước 4: Chạy test cho chắc nó pass**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: PASS, 17 test.

- [ ] **Bước 5: Dừng lại và báo**

Không commit. Báo: đã sửa `src/repair.mjs`, `test/repair.test.mjs`.

---

### Task 6: Hợp đồng bậc 2

Kiểm output của LLM **bằng code**, không tin lời dặn trong prompt. Đổi `line` là caption trôi khỏi giọng đọc.

**Files:**
- Modify: `src/repair.mjs`
- Modify: `test/repair.test.mjs`

**Interfaces:**
- Produces: `REPAIRABLE_FIELDS = ["head", "sub", "kicker"]` (export) — Task 7 nhét vào prompt.
- Produces: `validateRepairedChapters(original, repaired) → { ok, errors }`.

**Ghi chú so với spec:** spec viết "cấm đổi `start`". Ở tầng `chapters.src.json` chưa có `start` — nó do `mkchapters.mjs` tính ra sau, từ field `line`. Vậy trường phải khoá ở tầng này là **`line`**, cộng `kind` và `img`. Khoá `line` chính là khoá `start`.

- [ ] **Bước 1: Viết test thất bại**

Thêm vào `test/repair.test.mjs`:

```js
import { validateRepairedChapters, REPAIRABLE_FIELDS } from "../src/repair.mjs";

const base = () => [
  { line: "intro", kind: "intro", kicker: "ĐIỂM TIN NHANH", head: "BẢN TIN", sub: "" },
  { line: 0, kind: "image", img: "input/images/image_1.png", cat: "THỜI SỰ", head: "TIÊU ĐỀ MỘT" },
  { line: 2, kind: "divider", head: "CẢM ƠN QUÝ VỊ ĐÃ THEO DÕI" },
];

test("REPAIRABLE_FIELDS đúng ba trường nội dung", () => {
  assert.deepEqual([...REPAIRABLE_FIELDS].sort(), ["head", "kicker", "sub"]);
});

test("nhận khi chỉ đổi head", () => {
  const after = base();
  after[1].head = "TIÊU ĐỀ NGẮN HƠN";
  const { ok } = validateRepairedChapters(base(), after);
  assert.equal(ok, true);
});

test("từ chối khi số cảnh đổi", () => {
  const { ok, errors } = validateRepairedChapters(base(), base().slice(0, 2));
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /số cảnh đổi: 3 → 2/.test(e)), true);
});

test("từ chối khi line đổi — đổi line là caption trôi khỏi giọng đọc", () => {
  const after = base();
  after[1].line = 1;
  const { ok, errors } = validateRepairedChapters(base(), after);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /cảnh 1: "line" bị đổi/.test(e)), true);
});

test("từ chối khi kind đổi", () => {
  const after = base();
  after[1].kind = "story";
  const { ok, errors } = validateRepairedChapters(base(), after);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /"kind" bị đổi/.test(e)), true);
});

test("từ chối khi img đổi", () => {
  const after = base();
  after[1].img = "input/images/image_9.png";
  const { ok, errors } = validateRepairedChapters(base(), after);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /"img" bị đổi/.test(e)), true);
});

test("từ chối khi output không phải mảng", () => {
  const { ok, errors } = validateRepairedChapters(base(), { cards: [] });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
});
```

- [ ] **Bước 2: Chạy test để chắc chắn nó fail**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: FAIL — `validateRepairedChapters is not a function`.

- [ ] **Bước 3: Viết phần cài đặt**

Thêm vào cuối `src/repair.mjs`:

```js
// LLM ở bậc 2 chỉ được sửa chữ, không được đụng vào cấu trúc.
export const REPAIRABLE_FIELDS = ["head", "sub", "kicker"];

// "line" quyết định "start" sau khi qua mkchapters.mjs — đổi nó là caption
// trôi khỏi giọng đọc, đúng cái bẫy LEAD/TAIL trong CLAUDE.md.
const FROZEN_FIELDS = ["kind", "line", "img"];

export function validateRepairedChapters(original, repaired) {
  if (!Array.isArray(repaired)) return { ok: false, errors: ["output không phải mảng"] };

  const errors = [];
  if (repaired.length !== original.length) {
    errors.push(`số cảnh đổi: ${original.length} → ${repaired.length}`);
  }

  const n = Math.min(original.length, repaired.length);
  for (let i = 0; i < n; i++) {
    for (const f of FROZEN_FIELDS) {
      const a = JSON.stringify(original[i]?.[f]);
      const b = JSON.stringify(repaired[i]?.[f]);
      if (a !== b) errors.push(`cảnh ${i}: "${f}" bị đổi (${a} → ${b})`);
    }
  }

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Bước 4: Chạy test cho chắc nó pass**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: PASS, 24 test.

- [ ] **Bước 5: Dừng lại và báo**

Không commit. Báo: đã sửa `src/repair.mjs`, `test/repair.test.mjs`.

---

### Task 7: Điều phối thang

Ghép bốn bậc. Mọi tác dụng phụ (chạy check, build lại, gọi LLM) tiêm vào qua tham số để test được mà không cần browser hay token.

**Files:**
- Modify: `src/repair.mjs`
- Modify: `test/repair.test.mjs`

**Interfaces:**
- Consumes: `classifyFindings`, `planDeterministicFix`, `validateRepairedChapters` từ Task 4-6.
- Produces:

```
runRepairLadder({
  runCheck,        // async () => report   (kết quả check --json đã parse)
  rebuild,         // async ({ overrides, chapters }) => void
  repairWithLlm,   // async ({ findings, chapters }) => cards | null
  chapters,        // mảng card của chapters.src.json
  maxDeterministic = 2,
  maxLlm = 2,
  onLog = () => {},
}) → {
  ok,        // true khi không còn finding error nào
  blocking,  // mảng finding chặn cứng — khác rỗng nghĩa là phải fail job
  quality,   // mảng finding chất lượng còn lại
  repairs,   // mảng { rung, finding_code, scene?, action, ok }
  chapters,  // chapters cuối cùng (có thể đã bị bậc 2 sửa)
  overrides, // map đè cỡ chữ cuối cùng
  checks,    // số lần đã chạy runCheck
}
```

Task 8 là bên duy nhất gọi hàm này.

- [ ] **Bước 1: Viết test thất bại**

Thêm vào `test/repair.test.mjs`:

```js
import { runRepairLadder } from "../src/repair.mjs";

const clean = () => report();
const withOverlap = (scene = "sc0") =>
  report({ layout: { findings: [{ ...overlap, containerSelector: `#${scene}-k` }] } });

const chapters = () => [
  { line: "intro", kind: "intro", kicker: "K", head: "TIÊU ĐỀ RẤT DÀI CẦN THU NHỎ LẠI", sub: "" },
];

// runCheck giả: trả lần lượt các report đã dựng sẵn
const scriptedCheck = (reports) => {
  let i = 0;
  const fn = async () => reports[Math.min(i++, reports.length - 1)];
  fn.calls = () => i;
  return fn;
};

test("check sạch ngay lần đầu thì không sửa gì", async () => {
  const runCheck = scriptedCheck([clean()]);
  let rebuilt = 0;
  const r = await runRepairLadder({
    runCheck,
    rebuild: async () => { rebuilt++; },
    repairWithLlm: async () => { throw new Error("không được gọi LLM"); },
    chapters: chapters(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.repairs.length, 0);
  assert.equal(rebuilt, 0);
  assert.equal(r.checks, 1);
});

test("lỗi chặn cứng thì fail ngay, không vào thang", async () => {
  const blocking = report({ runtime: { findings: [{ code: "runtime_error", severity: "error" }] } });
  const r = await runRepairLadder({
    runCheck: scriptedCheck([blocking]),
    rebuild: async () => { throw new Error("không được build lại"); },
    repairWithLlm: async () => { throw new Error("không được gọi LLM"); },
    chapters: chapters(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.repairs.length, 0);
});

test("bậc 1 sửa xong thì không đụng tới bậc 2", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), clean()]),
    rebuild: async () => {},
    repairWithLlm: async () => { throw new Error("không được gọi LLM"); },
    chapters: chapters(),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.overrides, { sc0: "len2" });
  assert.equal(r.repairs.filter((x) => x.rung === 1).length, 1);
  assert.equal(r.repairs.every((x) => x.rung === 1), true);
});

test("bậc 1 chỉ chạy tối đa maxDeterministic vòng", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), withOverlap(), withOverlap(), clean()]),
    rebuild: async () => {},
    repairWithLlm: async () => null,
    chapters: chapters(),
    maxDeterministic: 2,
    maxLlm: 0,
  });
  assert.equal(r.repairs.filter((x) => x.rung === 1).length, 2);
});

test("bậc 2 chạy khi bậc 1 hết đường và kết quả hợp lệ được nhận", async () => {
  const fixed = chapters();
  fixed[0].head = "NGẮN";
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), withOverlap(), withOverlap(), clean()]),
    rebuild: async () => {},
    repairWithLlm: async () => fixed,
    chapters: chapters(),
    maxDeterministic: 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.chapters[0].head, "NGẮN");
  assert.equal(r.repairs.some((x) => x.rung === 2 && x.ok === true), true);
});

test("bậc 2 từ chối kết quả phá hợp đồng và không dùng nó", async () => {
  const bad = chapters();
  bad[0].line = 3; // đổi line — cấm
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), withOverlap(), withOverlap()]),
    rebuild: async () => {},
    repairWithLlm: async () => bad,
    chapters: chapters(),
    maxDeterministic: 1,
    maxLlm: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.chapters[0].line, "intro", "chapters gốc phải được giữ nguyên");
  assert.equal(r.repairs.some((x) => x.rung === 2 && x.ok === false), true);
});

test("hết cả thang thì trả ok=false nhưng vẫn có quality để bậc 3 xử", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap()]),
    rebuild: async () => {},
    repairWithLlm: async () => null,
    chapters: chapters(),
    maxDeterministic: 1,
    maxLlm: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 0, "không có lỗi chặn cứng thì job vẫn phải render được");
  assert.equal(r.quality.length > 0, true);
});

test("lỗi ném ra từ repairWithLlm không làm nổ thang", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap()]),
    rebuild: async () => {},
    repairWithLlm: async () => { throw new Error("claude timeout sau 300000ms"); },
    chapters: chapters(),
    maxDeterministic: 0,
    maxLlm: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.repairs.some((x) => x.rung === 2 && x.ok === false), true);
});
```

- [ ] **Bước 2: Chạy test để chắc chắn nó fail**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: FAIL — `runRepairLadder is not a function`.

- [ ] **Bước 3: Viết phần điều phối**

Thêm vào cuối `src/repair.mjs`:

```js
export async function runRepairLadder({
  runCheck,
  rebuild,
  repairWithLlm,
  chapters,
  maxDeterministic = 2,
  maxLlm = 2,
  onLog = () => {},
}) {
  const repairs = [];
  let overrides = {};
  let currentChapters = chapters;
  let checks = 0;

  const check = async () => {
    checks++;
    return classifyFindings(await runCheck());
  };

  let { blocking, quality } = await check();
  const done = () => ({ ok: blocking.length === 0 && quality.length === 0, blocking, quality, repairs, chapters: currentChapters, overrides, checks });

  if (blocking.length) {
    onLog(`check: ${blocking.length} lỗi chặn cứng — không sửa tự động được`);
    return done();
  }
  if (!quality.length) return done();

  // ---- bậc 1: sửa tất định ----
  for (let i = 0; i < maxDeterministic; i++) {
    const { overrides: next, actions } = planDeterministicFix(quality, overrides);
    if (!actions.length) break; // hết đường

    overrides = next;
    for (const a of actions) repairs.push({ ...a, ok: true });
    onLog(`bậc 1 vòng ${i + 1}: ${actions.map((a) => `${a.scene}→${a.action}`).join(", ")}`);

    await rebuild({ overrides, chapters: currentChapters });
    ({ blocking, quality } = await check());
    if (blocking.length) return done();
    if (!quality.length) return done();
  }

  // ---- bậc 2: Claude Code sửa nội dung ----
  for (let i = 0; i < maxLlm; i++) {
    let candidate = null;
    let why = null;
    try {
      candidate = await repairWithLlm({ findings: quality, chapters: currentChapters });
    } catch (e) {
      why = e.message;
    }

    if (!candidate) {
      repairs.push({ rung: 2, finding_code: quality[0]?.code || null, action: "llm_no_result", ok: false, error: why });
      onLog(`bậc 2 vòng ${i + 1}: không nhận được kết quả${why ? ` — ${why}` : ""}`);
      break;
    }

    const { ok: valid, errors } = validateRepairedChapters(currentChapters, candidate);
    if (!valid) {
      repairs.push({ rung: 2, finding_code: quality[0]?.code || null, action: "llm_rejected", ok: false, error: errors.join("; ") });
      onLog(`bậc 2 vòng ${i + 1}: từ chối kết quả — ${errors.join("; ")}`);
      continue;
    }

    currentChapters = candidate;
    repairs.push({ rung: 2, finding_code: quality[0]?.code || null, action: "llm_rewrote_text", ok: true });
    onLog(`bậc 2 vòng ${i + 1}: nhận bản sửa nội dung từ LLM`);

    await rebuild({ overrides, chapters: currentChapters });
    ({ blocking, quality } = await check());
    if (blocking.length) return done();
    if (!quality.length) return done();
  }

  // ---- bậc 3: sàn an toàn — caller vẫn render, chỉ cảnh báo ----
  onLog(`hết thang, còn ${quality.length} lỗi chất lượng — vẫn render`);
  return done();
}
```

- [ ] **Bước 4: Chạy test cho chắc nó pass**

Chạy: `node --test test/repair.test.mjs`
Kỳ vọng: PASS, 32 test.

- [ ] **Bước 5: Chạy toàn bộ test**

Chạy: `npm test` · Kỳ vọng: PASS toàn bộ.

- [ ] **Bước 6: Dừng lại và báo**

Không commit. Báo: đã sửa `src/repair.mjs`, `test/repair.test.mjs`.

---

### Task 8: Nối thang vào pipeline

**Files:**
- Modify: `src/pipeline.mjs` — khối `setStage(jobId, "checking", ...)` (~dòng 250-270) và khối `setStage(jobId, "rendering", ...)` ngay sau nó

**Interfaces:**
- Consumes: `runRepairLadder` từ Task 7; `validateChapters` từ `src/plan.mjs`.
- Produces: field `repairs` trong `status.json`; file `work/<job_id>/repair.json`. Task 9 đọc field `repairs`.

- [ ] **Bước 1: Thêm import**

Đầu `src/pipeline.mjs`, cạnh `import { planChapters } from "./plan.mjs";`:

```js
import { planChapters, repairChaptersWithLlm, validateChapters } from "./plan.mjs";
import { runRepairLadder } from "./repair.mjs";
```

- [ ] **Bước 2: Thay khối `checking`**

Tìm khối hiện tại (chạy `lint` rồi `check`, cả hai đều `throw`) và thay toàn bộ bằng:

```js
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "checking", 0.5, "hyperframes check + thang sửa lỗi");
    const hf = ["--yes", `hyperframes@${process.env.HYPERFRAMES_VERSION || "0.7.86"}`];
    const sizeOverridesPath = join(dir, "size-overrides.json");
    const chaptersSrcPath = join(dir, "chapters.src.json");

    // check đã chạy lint bên trong — không gọi lint riêng nữa.
    const runCheck = async () => {
      // KHÔNG dùng giá trị trả về của run(): nó chỉ giữ 4000 ký tự cuối, mà JSON của
      // check dài hơn thế nhiều. Gom toàn bộ stdout qua onLine.
      let raw = "";
      try {
        await run(jobId, "npx", [...hf, "check", "--json"], {
          cwd: projDir,
          register: registerChild,
          onLine: (s) => (raw += s),
        });
      } catch {
        // check thoát khác 0 khi có finding — chuyện bình thường, raw vẫn đủ dùng.
        // Tuyệt đối không gán đè raw ở đây, sẽ mất JSON đã gom được.
      }
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) throw Object.assign(new Error("check --json không trả JSON đọc được"), { code: "check_failed" });
      return JSON.parse(raw.slice(start, end + 1));
    };

    const rebuild = async ({ overrides, chapters }) => {
      writeFileSync(sizeOverridesPath, JSON.stringify(overrides, null, 1));
      writeFileSync(chaptersSrcPath, JSON.stringify(chapters, null, 1));
      await run(jobId, "node", [join(tpl, "mkchapters.mjs"), chaptersSrcPath, transcriptPath, join(dir, "chapters.json")], { register: registerChild });
      await run(jobId, "node", [
        join(tpl, "build.mjs"),
        "--out", projDir,
        "--audio", voFinal,
        "--transcript", transcriptPath,
        "--chapters", join(dir, "chapters.json"),
        "--brand", brand.name || "BẢN TIN",
        "--brand-sub", brand.sub || "TỔNG HỢP",
        "--date", brand.date || "",
        "--size-overrides", sizeOverridesPath,
        ...(opts.fps ? ["--fps", String(opts.fps)] : []),
      ], { cwd: dir, register: registerChild });
    };

    const repairWithLlm = async ({ findings, chapters }) => {
      const cards = await repairChaptersWithLlm({ findings, chapters, rows, bin: process.env.CLAUDE_BIN || "claude", onLog: (m) => log(jobId, m) });
      if (!cards) return null;
      const { ok, errors } = validateChapters(cards, rows.length);
      if (!ok) {
        log(jobId, `bậc 2: schema sai — ${errors.slice(0, 3).join("; ")}`);
        return null;
      }
      return cards;
    };

    const ladder = await runRepairLadder({
      runCheck,
      rebuild,
      repairWithLlm,
      chapters: plan.cards,
      onLog: (m) => log(jobId, m),
    });

    writeFileSync(join(dir, "repair.json"), JSON.stringify({ repairs: ladder.repairs, overrides: ladder.overrides, remaining: ladder.quality }, null, 1));
    patchStatus(jobId, { repairs: ladder.repairs });

    if (ladder.blocking.length) {
      const first = ladder.blocking[0];
      throw Object.assign(new Error(`${ladder.blocking.length} lỗi chặn cứng, đầu tiên: [${first.section}] ${first.code} — ${first.message || ""}`), { code: "check_failed" });
    }
    if (ladder.quality.length) {
      addWarning(jobId, "quality_degraded", `Còn ${ladder.quality.length} lỗi chất lượng sau khi tự sửa (${ladder.quality.map((f) => f.code).join(", ")}) — vẫn render`);
    }
    mark("checking", step);
```

- [ ] **Bước 3: Viết `repairChaptersWithLlm`**

Thêm vào cuối `src/plan.mjs` (dùng chung `runClaude` và `extractJsonArray` sẵn có):

```js
export async function repairChaptersWithLlm({ findings, chapters, rows, bin = "claude", onLog = () => {} }) {
  const list = findings
    .slice(0, 10)
    .map((f) => `- [${f.section}] ${f.code} tại ${f.containerSelector || f.selector || "?"}: ${f.message || ""}`)
    .join("\n");

  const prompt = `Bản đồ cảnh dưới đây dựng ra video bị lỗi bố cục. Sửa lại NỘI DUNG CHỮ cho vừa khung.

LỖI TỪ TRÌNH KIỂM TRA:
${list}

Nguyên nhân gần như luôn là tiêu đề quá dài so với khung. Hãy RÚT NGẮN chữ.

CHỈ ĐƯỢC SỬA: ${REPAIRABLE_FIELDS.join(", ")}
TUYỆT ĐỐI KHÔNG ĐỔI: số lượng cảnh, "line", "kind", "img". Đổi "line" là phụ đề trôi khỏi giọng đọc.
Trần độ dài head: intro 28 ký tự · divider 40 · story/image/headline 60 · quote 120.

ĐẦU RA: CHỈ một mảng JSON hợp lệ, không markdown, không giải thích.

BẢN ĐỒ CẢNH HIỆN TẠI:
${JSON.stringify(chapters, null, 1)}`;

  try {
    const raw = await runClaude(prompt, { bin });
    const cards = extractJsonArray(raw);
    const { cards: normalized } = normalizeKinds(cards);
    return normalized;
  } catch (e) {
    onLog(`bậc 2: gọi claude lỗi — ${e.message}`);
    return null;
  }
}
```

Thêm `REPAIRABLE_FIELDS` vào import đầu `src/plan.mjs`:

```js
import { REPAIRABLE_FIELDS } from "./repair.mjs";
```

- [ ] **Bước 4: Kiểm `hf` vẫn chỉ khai một lần**

`hf` được khai trong khối `checking` và **dùng lại** ở khối `rendering` (`[...hf, "render", …]`). Bước 2 đã giữ nguyên khai báo đó. Xác nhận không có khai báo thứ hai:

```bash
grep -cn "const hf = " src/pipeline.mjs
```

Kỳ vọng: `1`. Nếu ra `2` thì Bước 2 đã chèn thừa — xoá cái trong khối render.

- [ ] **Bước 5: Chạy toàn bộ test**

Chạy: `npm test`
Kỳ vọng: PASS. Test không chạm `pipeline.mjs`, mục đích là chắc chắn không có lỗi cú pháp hay import vòng.

- [ ] **Bước 6: Kiểm import vòng**

`plan.mjs` import `repair.mjs`, và `repair.mjs` **không được** import `plan.mjs`. Kiểm:

```bash
grep -n "^import" src/repair.mjs
node -e 'import("./src/pipeline.mjs").then(()=>console.log("import ok")).catch(e=>{console.error(e.message);process.exit(1)})'
```

Kỳ vọng: `src/repair.mjs` không có dòng import nào; lệnh thứ hai in `import ok`.

- [ ] **Bước 7: Dừng lại và báo**

Không commit. Báo: đã sửa `src/pipeline.mjs`, `src/plan.mjs`.

---

### Task 9: Badge trên UI

Không có phần này thì thang sửa là nợ kỹ thuật: LLM âm thầm vá còn `news.css` không ai sửa.

**Files:**
- Modify: `src/ui.mjs`

**Interfaces:**
- Consumes: field `repairs` trong status (Task 8) — mảng `{ rung, finding_code, scene?, action, ok, error? }`.

- [ ] **Bước 1: Thêm hàm tóm tắt**

Trong `src/ui.mjs`, cạnh bảng nhãn trạng thái (quanh dòng 25):

```js
export function repairBadge(repairs) {
  if (!Array.isArray(repairs) || repairs.length === 0) return "";
  const llm = repairs.filter((r) => r.rung === 2 && r.ok).length;
  const det = repairs.filter((r) => r.rung === 1 && r.ok).length;
  const failed = repairs.filter((r) => r.ok === false).length;
  const parts = [];
  if (det) parts.push(`${det} tự sửa`);
  if (llm) parts.push(`${llm} LLM sửa`);
  if (failed) parts.push(`${failed} không sửa được`);
  return parts.length ? `🔧 ${parts.join(" · ")}` : "";
}
```

- [ ] **Bước 2: Hiện badge trên dòng job**

Ở chỗ render một dòng job trong danh sách, thêm ngay sau nhãn trạng thái:

```js
${repairBadge(j.repairs) ? `<span class="badge" title="Xem repair.json trong thư mục job">${repairBadge(j.repairs)}</span>` : ""}
```

Nếu chưa có class `.badge` trong khối `<style>` của `ui.mjs`, thêm:

```css
.badge { margin-left: 8px; font-size: 12px; color: #b45309; }
```

- [ ] **Bước 3: Thêm test**

Tạo `test/ui.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { repairBadge } from "../src/ui.mjs";

test("không có sửa chữa thì không hiện badge", () => {
  assert.equal(repairBadge(undefined), "");
  assert.equal(repairBadge([]), "");
});

test("đếm riêng sửa tất định và sửa bằng LLM", () => {
  const b = repairBadge([
    { rung: 1, ok: true },
    { rung: 1, ok: true },
    { rung: 2, ok: true },
  ]);
  assert.match(b, /2 tự sửa/);
  assert.match(b, /1 LLM sửa/);
});

test("đếm cả lần sửa thất bại", () => {
  const b = repairBadge([{ rung: 2, ok: false, error: "từ chối" }]);
  assert.match(b, /1 không sửa được/);
});
```

- [ ] **Bước 4: Chạy test**

Chạy: `npm test`
Kỳ vọng: PASS, gồm 3 test mới.

- [ ] **Bước 5: Dừng lại và báo**

Không commit. Báo: đã sửa `src/ui.mjs`, tạo `test/ui.test.mjs`.

---

### Task 10: Cập nhật CLAUDE.md

Không sửa dòng này thì người hoặc agent đọc file sau sẽ tháo mất thang sửa vì tưởng nó vi phạm kiến trúc.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Bước 1: Thay nguyên tắc "Chỉ một bước dùng LLM"**

Trong mục *Nguyên tắc kiến trúc*, thay đoạn:

```
**Chỉ một bước dùng LLM.** Trong cả pipeline, việc duy nhất cần trí tuệ là chia bản tin
thành cảnh và đặt tiêu đề (`src/plan.mjs`). Mọi bước khác là script tất định. Đừng thêm
lời gọi LLM vào các bước còn lại — chúng phải chạy lại ra kết quả y hệt.
```

bằng:

```
**Hai bước dùng LLM, không hơn.** Bước một: chia bản tin thành cảnh và đặt tiêu đề
(`src/plan.mjs`). Bước hai: bậc 2 của thang sửa lỗi (`src/repair.mjs`) — **chỉ chạy khi
sửa tất định đã thất bại**, chỉ được sửa `head`/`sub`/`kicker`, cấm đổi số cảnh, `line`,
`kind`, `img`, và output luôn phải qua `validateChapters()` cộng
`validateRepairedChapters()`. Mọi bước khác là script tất định — đừng thêm lời gọi LLM
vào chúng.

Đánh đổi đã chấp nhận: khi bậc 2 chạy, cùng một storyboard có thể ra hai video khác nhau.
Bậc 0 (trần độ dài trong schema) và bậc 1 (bậc thang cỡ chữ) tồn tại để bậc 2 hiếm khi
phải chạy. Xem `docs/superpowers/specs/2026-08-05-thang-sua-loi-thiet-ke.md`.
```

- [ ] **Bước 2: Thêm bẫy mới vào mục "Bẫy đã gặp"**

Thêm vào cuối danh sách:

```
- **Tiêu đề intro dài là vỡ bố cục.** `.stage` cao 1100px, `.scene` là `inset:0` +
  `justify-content:center` nên nội dung cao hơn sẽ **tràn đều cả hai đầu** — phần tràn
  lên trên đè vào `.topbar`. `check` báo `content_overlap`. Trần độ dài nằm ở `HEAD_MAX`
  trong `src/plan.mjs`, bậc thang cỡ chữ nằm ở `INTRO_STEPS`/`HEAD_STEPS` trong
  `build.mjs` — đổi một bên phải đổi bên kia.
- **`.headline.sm` đã có nghĩa riêng** (tiêu đề dưới thẻ ảnh, 74px) — đừng dùng `.sm`
  cho bậc thang độ dài. Bậc thang dùng `.len2`/`.len3`/`.len4`, và các luật này phải nằm
  **cuối** `news.css` vì cùng độ đặc hiệu với `.headline.sm`.
```

- [ ] **Bước 3: Dừng lại và báo**

Không commit. Báo: đã sửa `CLAUDE.md`. Nhắc chủ repo rằng đây là file định hướng cho mọi agent về sau nên nên đọc kỹ trước khi đưa vào git.

---

## Việc còn lại, không thuộc kế hoạch này

- **Vendor GSAP.** `build.mjs:328` nạp GSAP từ `cdn.jsdelivr.net` — fetch mạng lúc render, trái quy tắc render tất định. Cần tải về `assets/` và trỏ vào file cục bộ.
- **Hàng đợi bền.** Job `queued` bị `reapInterrupted()` đánh `failed` khi restart. Đã bàn, chọn hướng chuyển job store sang PostgreSQL, chưa có spec.
- **ETA hàng đợi và cảnh báo lịch chồng giờ.**
