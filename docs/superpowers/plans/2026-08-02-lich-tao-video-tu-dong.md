# Lịch tạo video tự động — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server tự giữ bảng lịch, đến giờ tự dựng video và đẩy lên Google Drive — không cần hệ thống bên ngoài gọi API.

**Architecture:** Bảng `schedule` trong PostgreSQL giữ metadata (giờ hẹn, storyboard, trạng thái); file ghi âm và ảnh nằm trên đĩa tại `work/schedule/<id>/input/`. Vòng `setInterval` 30 giây nhặt dòng đến hạn bằng `FOR UPDATE SKIP LOCKED` rồi đẩy vào hàng đợi FIFO sẵn có. Pipeline `runJob()` không đổi một dòng.

**Tech Stack:** Node 22 ESM · Hono · `postgres` (porsager) · `node:test` · HTML render phía server

**Spec:** [`docs/superpowers/specs/2026-08-02-lich-tao-video-tu-dong-design.md`](../specs/2026-08-02-lich-tao-video-tu-dong-design.md)

## Global Constraints

- **Git giới hạn trong phạm vi thực thi:** commit trên nhánh `feat/lich-tao-video-tu-dong`. **KHÔNG `push`, KHÔNG `merge`, KHÔNG đụng `main`.**
- Lệnh chạy test là `npm test`, và nó phải chạy **mọi** file trong `test/`. Trên máy này `node --test test/` lỗi — dạng đúng là `node --test "test/**/*.test.mjs"`.
- Node ≥ 22, ESM thuần, đuôi `.mjs`, không TypeScript, không build step.
- **Không thêm framework UI.** Trang quản lý là HTML render phía server.
- Dependency mới **chỉ được thêm đúng một**: `postgres` (porsager). `package.json` đi từ 2 lên 3.
- Test dùng `node:test` có sẵn — không thêm test framework.
- Toàn bộ chữ hiển thị cho người dùng và comment trong code viết **tiếng Việt**, theo đúng codebase hiện tại.
- Không đụng vào `src/pipeline.mjs` phần orchestration 10 bước, `src/plan.mjs`, `src/storyboard.mjs` (trừ phần thêm hàm mới), và thư mục `templates/`.
- Giữ nguyên `POST /v1/jobs` và mọi endpoint `/v1/` hiện có.
- Múi giờ: `TZ=Asia/Ho_Chi_Minh`. Mốc thời gian lưu dạng `timestamptz`.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `src/scheduler.mjs` | Hàm quyết định thuần + vòng tick | 1, 5 |
| `src/schedule-validate.mjs` | Validate đầu vào lúc nhập — hàm thuần, không DB | 2 |
| `src/db.mjs` | Kết nối PostgreSQL + tạo bảng | 3 |
| `src/schedule.mjs` | CRUD dòng lịch + nhặt dòng đến hạn | 4 |
| `src/storyboard.mjs` | *(sửa)* thêm `brandFromParams()` | 2 |
| `src/store.mjs` | *(sửa)* thêm `scheduleDir()` | 3 |
| `src/server.mjs` | *(sửa)* route lịch, khởi động scheduler, job timeout | 6, 8 |
| `src/ui.mjs` | *(sửa)* trang `/schedule` | 7 |
| `src/pipeline.mjs` | *(sửa)* dọn `work/` sau upload Drive | 9 |
| `src/drive.mjs` | *(sửa)* `AbortSignal.timeout` cho `fetch` | 9 |
| `test/*.test.mjs` | Test cho hàm thuần + tầng DB | 1, 2, 4 |
| `Dockerfile`, `scripts/doctor.mjs`, `.env.example` | Cấu hình vận hành | 10 |

**Thứ tự phụ thuộc:** 1 → 2 → 3 → 4 → 5 → 6 → 7, và 8, 9, 10 độc lập (làm lúc nào cũng được).

---

### Task 1: Hàm quyết định thuần

Hai hàm không đọc DB, không ghi file, không gọi `Date.now()` — nhận `now` làm tham số. Nhờ vậy test được "trễ đúng 8 tiếng 1 phút" mà không phải chờ thật.

**Files:**
- Create: `src/scheduler.mjs`
- Create: `test/scheduler.test.mjs`
- Modify: `package.json` (thêm script `test`)

**Interfaces:**
- Produces:
  - `decideAction({ now: Date, runAt: Date, enabled: boolean, status: string, graceMs: number }) → "run" | "wait" | "miss"`
  - `isRetryable(code: string|null, attempts: number, maxAttempts: number) → boolean`
  - `RETRYABLE_CODES: Set<string>`

- [ ] **Bước 1: Thêm script test vào `package.json`**

Trong khối `"scripts"`, thêm dòng:

```json
    "test": "node --test \"test/**/*.test.mjs\""
```

- [ ] **Bước 2: Viết test thất bại**

Tạo `test/scheduler.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideAction, isRetryable } from "../src/scheduler.mjs";

const GRACE = 8 * 3600 * 1000; // 8 tiếng
const at = (s) => new Date(s);

test("decideAction: chưa tới giờ thì chờ", () => {
  const r = decideAction({
    now: at("2026-08-02T08:59:00+07:00"),
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "wait");
});

test("decideAction: đúng giờ thì chạy", () => {
  const r = decideAction({
    now: at("2026-08-02T09:00:00+07:00"),
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "run");
});

test("decideAction: trễ trong ngưỡng thì vẫn chạy bù", () => {
  const r = decideAction({
    now: at("2026-08-02T16:59:00+07:00"), // trễ 7h59
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "run");
});

test("decideAction: trễ quá ngưỡng thì bỏ lỡ", () => {
  const r = decideAction({
    now: at("2026-08-02T17:01:00+07:00"), // trễ 8h01
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "miss");
});

test("decideAction: tắt thì luôn chờ, kể cả quá hạn", () => {
  const r = decideAction({
    now: at("2026-08-03T09:00:00+07:00"),
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: false, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "wait");
});

test("decideAction: trạng thái không phải pending thì không đụng tới", () => {
  for (const status of ["claimed", "queued", "running", "done", "failed", "missed"]) {
    const r = decideAction({
      now: at("2026-08-02T09:00:00+07:00"),
      runAt: at("2026-08-02T09:00:00+07:00"),
      enabled: true, status, graceMs: GRACE,
    });
    assert.equal(r, "wait", `status ${status} phải trả về wait`);
  }
});

test("isRetryable: lỗi tạm thời thì thử lại", () => {
  for (const code of ["interrupted", "render_failed", "internal_error"]) {
    assert.equal(isRetryable(code, 0, 2), true, code);
  }
});

test("isRetryable: lỗi dữ liệu thì dừng", () => {
  for (const code of ["bad_input", "asr_empty", "align_failed", "lint_failed", "check_failed", "timeout"]) {
    assert.equal(isRetryable(code, 0, 2), false, code);
  }
});

test("isRetryable: hết lượt thì dừng dù lỗi tạm thời", () => {
  assert.equal(isRetryable("render_failed", 2, 2), false);
  assert.equal(isRetryable("render_failed", 1, 2), true);
});

test("isRetryable: code rỗng hoặc lạ thì dừng", () => {
  assert.equal(isRetryable(null, 0, 2), false);
  assert.equal(isRetryable("khong_biet", 0, 2), false);
});
```

- [ ] **Bước 3: Chạy test để xác nhận nó thất bại**

Chạy: `npm test`
Mong đợi: FAIL — `Cannot find module '../src/scheduler.mjs'`

- [ ] **Bước 4: Viết implementation tối thiểu**

Tạo `src/scheduler.mjs`:

```js
// Bộ hẹn giờ — quyết định dòng lịch nào được chạy, chạy bù, hay bỏ lỡ.
//
// Phần trên file là HÀM THUẦN: không đọc DB, không ghi file, không gọi
// Date.now(). Mọi mốc thời gian đi vào qua tham số. Nhờ vậy test được biên
// giới nửa đêm và "trễ đúng 8 tiếng 1 phút" mà không phải chờ thật.

/** Mã lỗi đáng thử lại — xem bảng trong spec mục 3. */
export const RETRYABLE_CODES = new Set(["interrupted", "render_failed", "internal_error"]);

/**
 * @returns {"run"|"wait"|"miss"}
 *   run  — đến hạn, còn trong ngưỡng chạy bù
 *   wait — chưa tới giờ, đang tắt, hoặc không ở trạng thái pending
 *   miss — quá ngưỡng, sẽ không bao giờ chạy
 */
export function decideAction({ now, runAt, enabled, status, graceMs }) {
  if (!enabled) return "wait";
  if (status !== "pending") return "wait";

  const late = now.getTime() - runAt.getTime();
  if (late < 0) return "wait";
  return late > graceMs ? "miss" : "run";
}

/**
 * Lỗi dữ liệu (storyboard sai, audio câm) chạy lại 100 lần vẫn hỏng y hệt,
 * mà mỗi lần tốn 45-70 phút CPU và chặn các dòng lịch phía sau.
 */
export function isRetryable(code, attempts, maxAttempts) {
  if (attempts >= maxAttempts) return false;
  return RETRYABLE_CODES.has(code);
}
```

- [ ] **Bước 5: Chạy test để xác nhận nó pass**

Chạy: `npm test`
Mong đợi: PASS — 10 test

- [ ] **Bước 6: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add package.json src/scheduler.mjs test/scheduler.test.mjs
git commit -m "feat(scheduler): hàm quyết định chạy/bù/bỏ lỡ và phân loại lỗi"
```

---

### Task 2: Validate đầu vào lúc nhập

Ba kiểm tra chạy trong 2 giây, thay cho việc phát hiện lỗi sau 60 phút render. Kiểm tra 3 bắt đúng lỗi có thật trong `prompts/`: audio 887 giây nhưng storyboard chỉ 5 dòng ≈ 76 giây.

**Files:**
- Create: `src/schedule-validate.mjs`
- Create: `test/schedule-validate.test.mjs`
- Modify: `src/storyboard.mjs` (thêm `brandFromParams`, cuối file)

**Interfaces:**
- Consumes: `parseStoryboard`, `imageIdFromRef` từ `src/storyboard.mjs` (đã có sẵn)
- Produces:
  - `validateScheduleInput({ storyboardText: string, imageIds: string[], audioDurationSec: number }) → { ok, errors, warnings, lineCount, referencedImages }`
  - `brandFromParams(params: object) → { name, sub, date }` *(trong `storyboard.mjs`)*

- [ ] **Bước 1: Viết test thất bại**

Tạo `test/schedule-validate.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateScheduleInput } from "../src/schedule-validate.mjs";
import { brandFromParams, parseStoryboard } from "../src/storyboard.mjs";

const SB = `## Thông số dựng

- **Thương hiệu:** BẢN TIN · THỜI SỰ — trung lập
- **Ngày ghi trên thanh trên cùng (topbar):** 27 · 07 — ngày phát

| # | Thời điểm | Lời thoại | Thời lượng | Hình ảnh gợi ý | Ghi chú chuyển cảnh |
| --- | --- | --- | --- | --- | --- |
| — | nghỉ 1,2s | — | — | — | Cut |
| 16 | 3:15 | "Giá vàng thế giới sáng nay tăng mạnh lên sát bốn nghìn một trăm đô la một ounce." | 14s | /prompts /image/image_1.png | Giữ hình |
| 17 | 3:29 | "Đồng yên Nhật rơi xuống mức thấp nhất trong bốn mươi năm so với đô la Mỹ." | 16s | /prompts /image/image_2.png | Cut |
`;

test("chặn khi storyboard không có dòng thoại nào", () => {
  const r = validateScheduleInput({ storyboardText: "# Chỉ có tiêu đề", imageIds: [], audioDurationSec: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.lineCount, 0);
  assert.match(r.errors[0], /lời thoại/i);
});

test("đọc đúng số dòng thoại, bỏ dòng nghỉ", () => {
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1", "image_2"],
    audioDurationSec: 30,
  });
  assert.equal(r.ok, true);
  assert.equal(r.lineCount, 2);
  assert.deepEqual(r.referencedImages, ["image_1", "image_2"]);
});

test("cảnh báo khi thiếu ảnh mà storyboard tham chiếu", () => {
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1"],
    audioDurationSec: 30,
  });
  assert.equal(r.ok, true, "thiếu ảnh chỉ cảnh báo, không chặn lưu");
  assert.equal(r.warnings.filter((w) => w.includes("image_2")).length, 1);
});

test("cảnh báo khi audio dài hơn kịch bản quá nhiều", () => {
  // 2 dòng ~26 từ  ->  ước tính ~10s. Audio 887s = lệch cực lớn.
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1", "image_2"],
    audioDurationSec: 887,
  });
  assert.equal(r.ok, true, "lệch thời lượng chỉ cảnh báo");
  assert.equal(r.warnings.some((w) => /thời lượng|lệch/i.test(w)), true);
});

test("không cảnh báo thời lượng khi khớp nhau", () => {
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1", "image_2"],
    audioDurationSec: 11,
  });
  assert.equal(r.warnings.some((w) => /lệch/i.test(w)), false);
});

test("brandFromParams tách được tên, chuyên mục và ngày", () => {
  const { params } = parseStoryboard(SB);
  assert.deepEqual(brandFromParams(params), { name: "BẢN TIN", sub: "THỜI SỰ", date: "27 · 07" });
});

test("brandFromParams rơi về mặc định khi storyboard không khai", () => {
  assert.deepEqual(brandFromParams({}), { name: "BẢN TIN", sub: "TỔNG HỢP", date: "" });
});
```

- [ ] **Bước 2: Chạy test để xác nhận nó thất bại**

Chạy: `npm test`
Mong đợi: FAIL — `Cannot find module '../src/schedule-validate.mjs'`

- [ ] **Bước 3: Thêm `brandFromParams` vào `src/storyboard.mjs`**

Thêm vào **cuối** file `src/storyboard.mjs`:

```js
/**
 * Storyboard đã khai sẵn thương hiệu và ngày ở khối "Thông số dựng":
 *   - **Thương hiệu:** BẢN TIN · THỜI SỰ — trung lập, không mạo danh báo/đài
 *   - **Ngày ghi trên thanh trên cùng (topbar):** 27 · 07 — ngày phát bản tin
 * Lấy luôn từ đó thay vì bắt người dùng nhập lại trên form.
 * Phần sau dấu "—" là ghi chú cho người đọc, không phải dữ liệu.
 */
export function brandFromParams(params = {}) {
  const clean = (s) => String(s || "").split("—")[0].trim();

  const [name, sub] = clean(params["thương hiệu"]).split("·").map((s) => s.trim());
  const date = clean(params["ngày ghi trên thanh trên cùng (topbar)"] || params["ngày"]);

  return { name: name || "BẢN TIN", sub: sub || "TỔNG HỢP", date: date || "" };
}
```

- [ ] **Bước 4: Viết `src/schedule-validate.mjs`**

```js
// Kiểm tra dữ liệu ngay lúc người dùng bấm Lưu, trước khi tốn một phút CPU nào.
//
// Đây là lợi ích lớn nhất của việc nhập liệu qua UI thay vì bảng tính: ba lỗi
// dưới đây vốn chỉ lộ ra sau 25-60 phút chạy, giờ lộ ra sau 2 giây.
import { imageIdFromRef, parseStoryboard } from "./storyboard.mjs";

// Tốc độ đọc tham khảo của giọng TTS tiếng Việt. Âm tiết ≈ từ cách nhau bởi
// khoảng trắng, nên đếm từ là đủ chính xác cho một ước lượng thô.
const SYLLABLES_PER_MIN = 150;
const DURATION_TOLERANCE = 0.3; // lệch quá 30% thì cảnh báo

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[],
 *             lineCount: number, referencedImages: string[] }}
 *   errors   — chặn lưu
 *   warnings — hiện nổi bật nhưng vẫn cho lưu
 */
export function validateScheduleInput({ storyboardText, imageIds = [], audioDurationSec = 0 }) {
  const errors = [];
  const warnings = [];

  const { rows } = parseStoryboard(storyboardText || "");

  // ── 1. Storyboard có đọc được không ──────────────────────────────────────
  if (rows.length === 0) {
    errors.push("Không đọc được dòng lời thoại nào từ storyboard — kiểm tra bảng markdown có cột 'Lời thoại' chưa");
    return { ok: false, errors, warnings, lineCount: 0, referencedImages: [] };
  }

  // ── 2. Ảnh storyboard nhắc tới đã upload đủ chưa ─────────────────────────
  const referencedImages = [...new Set(rows.map((r) => imageIdFromRef(r.image)).filter(Boolean))];
  for (const id of referencedImages) {
    if (!imageIds.includes(id)) {
      warnings.push(`Storyboard tham chiếu ảnh "${id}" nhưng chưa upload — cảnh đó sẽ thiếu hình`);
    }
  }

  // ── 3. Thời lượng audio có khớp kịch bản không ───────────────────────────
  // Lệch lớn = file ghi âm không phải bản đọc của storyboard này. Chạy thật
  // sẽ ra align_failed sau ~25 phút, hoặc tệ hơn là video dài mà caption chỉ
  // có ở một đoạn ngắn.
  if (audioDurationSec > 0) {
    const syllables = rows.reduce((n, r) => n + r.text.split(/\s+/).filter(Boolean).length, 0);
    const estimated = (syllables / SYLLABLES_PER_MIN) * 60;
    const off = Math.abs(audioDurationSec - estimated) / estimated;

    if (off > DURATION_TOLERANCE) {
      warnings.push(
        `File ghi âm dài ${Math.round(audioDurationSec)}s nhưng kịch bản ước tính ${Math.round(estimated)}s ` +
          `— lệch ${Math.round(off * 100)}%. Kiểm tra xem file ghi âm có đúng là bản đọc của storyboard này không.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, lineCount: rows.length, referencedImages };
}
```

- [ ] **Bước 5: Chạy test để xác nhận nó pass**

Chạy: `npm test`
Mong đợi: PASS — 17 test (10 của Task 1 + 7 mới)

- [ ] **Bước 6: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/schedule-validate.mjs src/storyboard.mjs test/schedule-validate.test.mjs
git commit -m "feat(schedule): validate storyboard, ảnh và thời lượng audio lúc nhập"
```

---

### Task 3: Tầng PostgreSQL

**Files:**
- Create: `src/db.mjs`
- Modify: `package.json` (thêm dependency `postgres`)
- Modify: `src/store.mjs` (thêm `scheduleDir`, cuối file)
- Modify: `.env.example` (thêm `DATABASE_URL`)

**Interfaces:**
- Produces:
  - `getSql() → postgres.Sql` — singleton, ném lỗi nếu thiếu `DATABASE_URL`
  - `initSchema(sql) → Promise<void>` — chạy được nhiều lần, không hỏng
  - `closeSql() → Promise<void>` — dùng trong test
  - `scheduleDir(id) → string` *(trong `store.mjs`)* — `work/schedule/<id>`

- [ ] **Bước 1: Cài dependency**

Chạy: `npm install postgres`

Kiểm tra `package.json` sau khi cài — khối `dependencies` phải đúng ba mục:

```json
  "dependencies": {
    "@hono/node-server": "^1.13.7",
    "hono": "^4.6.14",
    "postgres": "^3.4.5"
  }
```

- [ ] **Bước 2: Thêm `scheduleDir` vào `src/store.mjs`**

Thêm ngay **dưới** hàm `jobDir` đã có:

```js
/**
 * Thư mục dữ liệu của một dòng lịch: file ghi âm và ảnh do người dùng upload.
 * Khác với jobDir — thư mục này sống lâu, mỗi lần chạy sẽ COPY từ đây sang
 * thư mục job. Nhờ vậy dọn dẹp job không làm mất nguồn để chạy lại.
 */
export function scheduleDir(id) {
  return join(WORK_DIR, "schedule", String(id));
}
```

- [ ] **Bước 3: Viết `src/db.mjs`**

```js
// Kết nối PostgreSQL cho bảng lịch.
//
// PHÂN VAI: PostgreSQL trả lời "chạy cái gì, lúc nào". Đĩa trả lời "lần chạy
// đó ra sao". Job store trong store.mjs vẫn nằm trên hệ thống file — xem spec
// mục 1 để biết vì sao không gộp cả hai vào đây.
import postgres from "postgres";

let sql = null;

export function getSql() {
  if (sql) return sql;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — xem .env.example");

  sql = postgres(url, {
    max: 4,
    onnotice: () => {}, // "relation already exists" của CREATE IF NOT EXISTS — không cần in
  });
  return sql;
}

export async function closeSql() {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = null;
}

/**
 * Một bảng duy nhất thì CREATE TABLE IF NOT EXISTS là đủ — thêm framework
 * migration vào đây là trả giá cho thứ không dùng.
 */
export async function initSchema(client = getSql()) {
  await client`
    CREATE TABLE IF NOT EXISTS schedule (
      id          bigserial PRIMARY KEY,
      name        text        NOT NULL,
      run_at      timestamptz NOT NULL,
      storyboard  text        NOT NULL,
      note        text        NOT NULL DEFAULT '',
      enabled     boolean     NOT NULL DEFAULT true,

      status      text        NOT NULL DEFAULT 'pending',
      attempts    int         NOT NULL DEFAULT 0,
      job_id      text,
      video_link  text,
      last_error  text,
      claimed_at  timestamptz,

      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`;

  await client`
    CREATE INDEX IF NOT EXISTS schedule_due_idx
      ON schedule (run_at) WHERE enabled AND status = 'pending'`;
}
```

- [ ] **Bước 4: Thêm cấu hình vào `.env.example`**

Chèn **trước** khối `# ── Render ──`:

```bash
# ── Cơ sở dữ liệu (bảng lịch tạo video) ──────────────────────────────────────
DATABASE_URL=postgres://user:pass@localhost:5432/bantin
# Dùng cho test tầng DB. Bỏ trống thì test đó tự bỏ qua.
TEST_DATABASE_URL=
```

- [ ] **Bước 5: Kiểm tra module nạp được**

Chạy: `node -e "import('./src/db.mjs').then(m => console.log(Object.keys(m)))"`
Mong đợi: in ra `[ 'closeSql', 'getSql', 'initSchema' ]`

- [ ] **Bước 6: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add package.json package-lock.json src/db.mjs src/store.mjs .env.example
git commit -m "feat(db): kết nối PostgreSQL và schema bảng schedule"
```

---

### Task 4: CRUD và nhặt dòng đến hạn

`claimDue` là phần đáng giá nhất của việc chọn PostgreSQL: `FOR UPDATE SKIP LOCKED` khiến việc nhặt dòng trở thành thao tác nguyên tử, nên một dòng lịch không bao giờ bị dựng thành hai video.

**Files:**
- Create: `src/schedule.mjs`
- Create: `test/schedule.test.mjs`

**Interfaces:**
- Consumes: `getSql`, `initSchema`, `closeSql` từ `src/db.mjs`
- Produces (mọi hàm nhận `sql` làm tham số đầu để test truyền client riêng):
  - `listRows(sql) → Promise<Row[]>` — mới nhất trước
  - `getRow(sql, id) → Promise<Row|null>`
  - `createRow(sql, { name, runAt, storyboard, note, enabled }) → Promise<Row>`
  - `updateRow(sql, id, { name, runAt, storyboard, note }) → Promise<Row|null>`
  - `setEnabled(sql, id, enabled) → Promise<Row|null>`
  - `deleteRow(sql, id) → Promise<boolean>`
  - `markRow(sql, id, patch) → Promise<Row|null>` — patch nhận `status`, `attempts`, `job_id`, `video_link`, `last_error`
  - `claimDue(sql) → Promise<Row|null>`
  - `reclaimStale(sql, staleMs) → Promise<number>`
  - `rowsInFlight(sql) → Promise<Row[]>` — status ∈ (claimed, queued, running)
  - `resetToPending(sql, id) → Promise<Row|null>`
  - `scheduleRetry(sql, id, { attempts, runAt, lastError }) → Promise<Row|null>` — về `pending` kèm giờ hẹn mới

`Row` là object có đúng các cột của bảng `schedule`.

- [ ] **Bước 1: Viết test thất bại**

Tạo `test/schedule.test.mjs`. Test tầng DB cần database thật — bỏ qua khi chưa cấu hình:

```js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

import { initSchema } from "../src/db.mjs";
import {
  claimDue, createRow, deleteRow, getRow, listRows, markRow, reclaimStale,
  resetToPending, rowsInFlight, scheduleRetry, setEnabled, updateRow,
} from "../src/schedule.mjs";

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : "cần TEST_DATABASE_URL trỏ tới một database dùng riêng cho test";

let sql;
const soon = () => new Date(Date.now() - 1000);       // đã đến hạn
const later = () => new Date(Date.now() + 3600_000);  // một tiếng nữa

before(async () => {
  if (!URL) return;
  sql = postgres(URL, { onnotice: () => {} });
  await initSchema(sql);
});

beforeEach(async () => {
  if (!URL) return;
  await sql`TRUNCATE schedule RESTART IDENTITY`;
});

after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

const seed = (over = {}) =>
  createRow(sql, {
    name: "Tin tức vàng", runAt: later(), storyboard: "| Lời thoại |\n| --- |\n| Xin chào |",
    note: "", enabled: true, ...over,
  });

test("createRow rồi getRow trả về đúng dòng", { skip }, async () => {
  const created = await seed();
  assert.equal(created.name, "Tin tức vàng");
  assert.equal(created.status, "pending");
  assert.equal(created.attempts, 0);
  assert.equal(created.enabled, true);

  const found = await getRow(sql, created.id);
  assert.equal(found.id, created.id);
});

test("getRow trả null khi không có", { skip }, async () => {
  assert.equal(await getRow(sql, 999999), null);
});

test("listRows sắp xếp theo run_at tăng dần", { skip }, async () => {
  const b = await seed({ name: "sau", runAt: new Date(Date.now() + 7200_000) });
  const a = await seed({ name: "trước", runAt: later() });
  const rows = await listRows(sql);
  assert.deepEqual(rows.map((r) => r.id), [a.id, b.id]);
});

test("updateRow sửa được nội dung", { skip }, async () => {
  const r = await seed();
  const u = await updateRow(sql, r.id, { name: "Tên mới", note: "ghi chú" });
  assert.equal(u.name, "Tên mới");
  assert.equal(u.note, "ghi chú");
});

test("setEnabled bật tắt được mà không đụng status", { skip }, async () => {
  const r = await seed();
  const off = await setEnabled(sql, r.id, false);
  assert.equal(off.enabled, false);
  assert.equal(off.status, "pending", "tắt không được làm mất trạng thái");
});

test("deleteRow xoá thật", { skip }, async () => {
  const r = await seed();
  assert.equal(await deleteRow(sql, r.id), true);
  assert.equal(await getRow(sql, r.id), null);
  assert.equal(await deleteRow(sql, r.id), false);
});

test("claimDue chỉ nhặt dòng đã đến hạn", { skip }, async () => {
  await seed({ name: "tương lai", runAt: later() });
  const due = await seed({ name: "đến hạn", runAt: soon() });

  const got = await claimDue(sql);
  assert.equal(got.id, due.id);
  assert.equal(got.status, "claimed");
  assert.ok(got.claimed_at);
});

test("claimDue bỏ qua dòng đang tắt", { skip }, async () => {
  await seed({ runAt: soon(), enabled: false });
  assert.equal(await claimDue(sql), null);
});

test("claimDue không nhặt lại dòng đã nhặt", { skip }, async () => {
  await seed({ runAt: soon() });
  assert.ok(await claimDue(sql));
  assert.equal(await claimDue(sql), null, "gọi lần hai phải trả null");
});

test("claimDue nhặt dòng cũ nhất trước", { skip }, async () => {
  const old = await seed({ name: "cũ", runAt: new Date(Date.now() - 7200_000) });
  await seed({ name: "mới", runAt: soon() });
  const got = await claimDue(sql);
  assert.equal(got.id, old.id);
});

test("markRow cập nhật trạng thái và lỗi", { skip }, async () => {
  const r = await seed();
  const m = await markRow(sql, r.id, { status: "failed", last_error: "align_failed", attempts: 1 });
  assert.equal(m.status, "failed");
  assert.equal(m.last_error, "align_failed");
  assert.equal(m.attempts, 1);
});

test("rowsInFlight trả về dòng đang bay", { skip }, async () => {
  const a = await seed();
  await markRow(sql, a.id, { status: "running" });
  const b = await seed();
  await markRow(sql, b.id, { status: "done" });

  const flight = await rowsInFlight(sql);
  assert.deepEqual(flight.map((r) => r.id), [a.id]);
});

test("reclaimStale trả dòng kẹt ở claimed về pending", { skip }, async () => {
  const r = await seed({ runAt: soon() });
  await claimDue(sql);
  await sql`UPDATE schedule SET claimed_at = now() - interval '20 minutes' WHERE id = ${r.id}`;

  assert.equal(await reclaimStale(sql, 600_000), 1);
  assert.equal((await getRow(sql, r.id)).status, "pending");
});

test("reclaimStale không đụng dòng vừa nhặt", { skip }, async () => {
  await seed({ runAt: soon() });
  await claimDue(sql);
  assert.equal(await reclaimStale(sql, 600_000), 0);
});

test("resetToPending xoá claimed_at để nhặt lại được", { skip }, async () => {
  const r = await seed({ runAt: soon() });
  await claimDue(sql);
  const back = await resetToPending(sql, r.id);
  assert.equal(back.status, "pending");
  assert.equal(back.claimed_at, null);
  assert.ok(await claimDue(sql), "phải nhặt lại được");
});

test("scheduleRetry dời giờ hẹn và tăng attempts", { skip }, async () => {
  const r = await seed({ runAt: soon() });
  await claimDue(sql);
  const retryAt = new Date(Date.now() + 300_000);

  const back = await scheduleRetry(sql, r.id, { attempts: 1, runAt: retryAt, lastError: "render_failed" });
  assert.equal(back.status, "pending");
  assert.equal(back.attempts, 1);
  assert.equal(back.job_id, null);
  assert.equal(back.last_error, "render_failed");

  assert.equal(await claimDue(sql), null, "chưa tới giờ thử lại thì không được nhặt");
});
```

- [ ] **Bước 2: Chạy test để xác nhận nó thất bại**

Chạy: `npm test`
Mong đợi: FAIL — `Cannot find module '../src/schedule.mjs'`

- [ ] **Bước 3: Viết `src/schedule.mjs`**

```js
// CRUD bảng lịch + nhặt dòng đến hạn.
//
// Mọi hàm nhận `sql` làm tham số đầu thay vì tự gọi getSql(), để test truyền
// vào client trỏ database riêng mà không phải đụng biến môi trường.
const COLS = ["name", "run_at", "storyboard", "note", "enabled",
              "status", "attempts", "job_id", "video_link", "last_error"];

/** Trạng thái "đang bay" — đã rời pending nhưng chưa tới đích. */
const IN_FLIGHT = ["claimed", "queued", "running"];

export async function listRows(sql) {
  return sql`SELECT * FROM schedule ORDER BY run_at ASC, id ASC`;
}

export async function getRow(sql, id) {
  const [row] = await sql`SELECT * FROM schedule WHERE id = ${id}`;
  return row || null;
}

export async function createRow(sql, { name, runAt, storyboard, note = "", enabled = true }) {
  const [row] = await sql`
    INSERT INTO schedule (name, run_at, storyboard, note, enabled)
    VALUES (${name}, ${runAt}, ${storyboard}, ${note}, ${enabled})
    RETURNING *`;
  return row;
}

export async function updateRow(sql, id, patch) {
  const allowed = { name: patch.name, run_at: patch.runAt, storyboard: patch.storyboard, note: patch.note };
  const set = Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length === 0) return getRow(sql, id);

  const [row] = await sql`
    UPDATE schedule SET ${sql(set)}, updated_at = now() WHERE id = ${id} RETURNING *`;
  return row || null;
}

export async function setEnabled(sql, id, enabled) {
  const [row] = await sql`
    UPDATE schedule SET enabled = ${enabled}, updated_at = now() WHERE id = ${id} RETURNING *`;
  return row || null;
}

export async function deleteRow(sql, id) {
  const rows = await sql`DELETE FROM schedule WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function markRow(sql, id, patch) {
  const set = Object.fromEntries(Object.entries(patch).filter(([k, v]) => COLS.includes(k) && v !== undefined));
  if (Object.keys(set).length === 0) return getRow(sql, id);

  const [row] = await sql`
    UPDATE schedule SET ${sql(set)}, updated_at = now() WHERE id = ${id} RETURNING *`;
  return row || null;
}

/**
 * Nhặt MỘT dòng đến hạn, nguyên tử.
 *
 * FOR UPDATE SKIP LOCKED là mấu chốt: kể cả hai tick chạy chồng lên nhau, hay
 * sau này chạy nhiều instance server, một dòng lịch không bao giờ bị dựng
 * thành hai video. Đây là lý do kỹ thuật để chọn PostgreSQL, không chỉ vì
 * server đã có sẵn nó.
 */
export async function claimDue(sql) {
  const [row] = await sql`
    UPDATE schedule
       SET status = 'claimed', claimed_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM schedule
        WHERE enabled AND status = 'pending' AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING *`;
  return row || null;
}

/**
 * Server chết đúng khoảnh khắc giữa claim và enqueue thì dòng kẹt ở 'claimed'.
 * Quá staleMs thì trả về pending để tick sau nhặt lại.
 */
export async function reclaimStale(sql, staleMs) {
  const rows = await sql`
    UPDATE schedule
       SET status = 'pending', claimed_at = NULL, updated_at = now()
     WHERE status = 'claimed'
       AND claimed_at < now() - ${`${Math.round(staleMs / 1000)} seconds`}::interval
     RETURNING id`;
  return rows.length;
}

export async function rowsInFlight(sql) {
  return sql`SELECT * FROM schedule WHERE status IN ${sql(IN_FLIGHT)} ORDER BY run_at ASC`;
}

export async function resetToPending(sql, id) {
  const [row] = await sql`
    UPDATE schedule
       SET status = 'pending', claimed_at = NULL, job_id = NULL, updated_at = now()
     WHERE id = ${id}
     RETURNING *`;
  return row || null;
}

/**
 * Xếp lại lịch cho một lần thử nữa: về pending, dời run_at tới mốc chờ, tăng
 * attempts. Gộp thành một câu lệnh để không có khoảnh khắc nào dòng ở trạng
 * thái nửa vời mà tick khác nhặt mất.
 */
export async function scheduleRetry(sql, id, { attempts, runAt, lastError }) {
  const [row] = await sql`
    UPDATE schedule
       SET status = 'pending', claimed_at = NULL, job_id = NULL,
           attempts = ${attempts}, run_at = ${runAt}, last_error = ${lastError},
           updated_at = now()
     WHERE id = ${id}
     RETURNING *`;
  return row || null;
}
```

- [ ] **Bước 4: Tạo database cho test và chạy**

```bash
createdb bantin_test
export TEST_DATABASE_URL=postgres://localhost:5432/bantin_test
npm test
```

Mong đợi: PASS — 33 test. Không đặt `TEST_DATABASE_URL` thì 16 test của file này báo `skipped`, không phải `failed`.

- [ ] **Bước 5: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/schedule.mjs test/schedule.test.mjs
git commit -m "feat(schedule): CRUD và nhặt dòng đến hạn bằng FOR UPDATE SKIP LOCKED"
```

---

### Task 5: Vòng tick

**Files:**
- Modify: `src/scheduler.mjs` (thêm phần orchestration **dưới** các hàm thuần của Task 1)
- Modify: `.env.example` (thêm khối bộ hẹn giờ)

**Interfaces:**
- Consumes: `decideAction`, `isRetryable` (Task 1) · `claimDue`, `markRow`, `reclaimStale`, `resetToPending`, `rowsInFlight` (Task 4) · `readStatus` từ `src/store.mjs`
- Produces:
  - `tick({ sql, now, enqueueJob, log, cfg }) → Promise<void>`
  - `startScheduler({ sql, enqueueJob, log }) → void`
  - `stopScheduler() → void`
  - `schedulerConfig() → { tickMs, graceMs, maxAttempts, retryDelayMs, claimStaleMs }`
  - `lastTick() → string|null` — mốc ISO của tick gần nhất, cho `/health`
- `enqueueJob(row) → Promise<string>` là callback do `server.mjs` cung cấp (Task 6), trả về `job_id`.

- [ ] **Bước 1: Thêm cấu hình vào `.env.example`**

Chèn **sau** khối `# ── Render ──`:

```bash
# ── Bộ hẹn giờ tạo video ─────────────────────────────────────────────────────
# BẮT BUỘC. VPS mặc định chạy UTC — không đặt thì hẹn 09:00 sẽ chạy lúc 16:00 giờ VN.
TZ=Asia/Ho_Chi_Minh
SCHEDULE_TICK_MS=30000
# Trễ quá ngưỡng này thì bỏ lỡ, không chạy bù nữa.
# Quy tắc chọn: >= số video hẹn trong ngày x 1.2 (mỗi video tốn 45-70 phút, chạy tuần tự).
SCHEDULE_GRACE_HOURS=8
SCHEDULE_MAX_ATTEMPTS=2
SCHEDULE_RETRY_DELAY_MS=300000
```

- [ ] **Bước 2: Thêm phần orchestration vào `src/scheduler.mjs`**

Thêm vào **cuối** file (giữ nguyên phần hàm thuần đã có):

```js
// ── Vòng tick ───────────────────────────────────────────────────────────────
// Mỗi tick làm hai việc: nhặt dòng đến hạn, và đối soát dòng đang bay.
// Việc thứ hai khiến hệ thống TỰ LÀNH sau khi server restart — không cần
// logic khôi phục riêng.
import { claimDue, markRow, reclaimStale, resetToPending, rowsInFlight, scheduleRetry } from "./schedule.mjs";
import { readStatus } from "./store.mjs";

const CLAIM_STALE_MS = 600_000; // 10 phút kẹt ở 'claimed' = server đã chết giữa chừng
const DRAIN_CAP = 20;           // chặn vòng lặp vô hạn nếu claimDue có bug

/** Mốc tick gần nhất — /health phơi ra để giám sát ngoài phát hiện tick chết. */
let lastTickAt = null;
export const lastTick = () => lastTickAt;

/** Bắn cảnh báo, nuốt mọi lỗi: chuông báo cháy hỏng không được làm cháy nhà. */
async function alertWebhook(payload) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* bỏ qua */ }
}

export function schedulerConfig() {
  return {
    tickMs: Number(process.env.SCHEDULE_TICK_MS || 30_000),
    graceMs: Number(process.env.SCHEDULE_GRACE_HOURS || 8) * 3600 * 1000,
    maxAttempts: Number(process.env.SCHEDULE_MAX_ATTEMPTS || 2),
    retryDelayMs: Number(process.env.SCHEDULE_RETRY_DELAY_MS || 300_000),
    claimStaleMs: CLAIM_STALE_MS,
  };
}

/** Đối soát một dòng đang bay với status.json của job tương ứng. */
async function reconcileRow(sql, row, cfg, log) {
  if (!row.job_id) return;
  const job = readStatus(row.job_id);

  // Thư mục job biến mất (bị xoá tay) — coi như chưa chạy, cho thử lại.
  if (!job) {
    log(`lịch #${row.id}: không thấy job ${row.job_id}, trả về pending`);
    await resetToPending(sql, row.id);
    return;
  }

  if (job.status === "done") {
    await markRow(sql, row.id, {
      status: "done",
      video_link: job.drive?.link || null,
      last_error: null,
    });
    log(`lịch #${row.id}: xong → ${job.drive?.link || "(chưa cấu hình Drive)"}`);
    return;
  }

  if (job.status === "failed") {
    const code = job.error?.code || null;
    const attempts = row.attempts + 1;

    if (isRetryable(code, row.attempts, cfg.maxAttempts)) {
      // Dời run_at tới tương lai gần — tick sau retryDelayMs sẽ nhặt lại.
      await scheduleRetry(sql, row.id, {
        attempts,
        runAt: new Date(Date.now() + cfg.retryDelayMs),
        lastError: code,
      });
      log(`lịch #${row.id}: lỗi ${code}, thử lại lần ${attempts}/${cfg.maxAttempts} sau ${cfg.retryDelayMs / 60000} phút`);
      return;
    }

    await markRow(sql, row.id, {
      status: "failed",
      attempts,
      last_error: `${code}: ${job.error?.message || ""}`.slice(0, 500),
    });
    log(`lịch #${row.id}: lỗi ${code}, dừng`);
    await alertWebhook({
      event: "schedule_failed",
      schedule_id: row.id, name: row.name, job_id: row.job_id,
      error: { code, message: String(job.error?.message || "").slice(0, 300) },
    });
    return;
  }

  if (job.status === "cancelled") {
    await markRow(sql, row.id, { status: "failed", last_error: "job bị huỷ" });
    return;
  }

  // Job còn đang chạy — đồng bộ nhãn để UI hiện đúng.
  if (row.status !== "running") await markRow(sql, row.id, { status: "running" });
}

export async function tick({ sql, now = new Date(), enqueueJob, log = () => {}, cfg = schedulerConfig() }) {
  lastTickAt = new Date().toISOString();

  // ── Việc 1: đối soát dòng đang bay ────────────────────────────────────────
  for (const row of await rowsInFlight(sql)) {
    if (row.status === "claimed") continue; // để reclaimStale lo
    try {
      await reconcileRow(sql, row, cfg, log);
    } catch (e) {
      log(`lịch #${row.id}: lỗi đối soát — ${e.message}`);
    }
  }

  const reclaimed = await reclaimStale(sql, cfg.claimStaleMs);
  if (reclaimed) log(`trả ${reclaimed} dòng kẹt ở claimed về pending`);

  // ── Việc 2: nhặt dòng đến hạn ─────────────────────────────────────────────
  for (let i = 0; i < DRAIN_CAP; i++) {
    const row = await claimDue(sql);
    if (!row) break;

    const action = decideAction({
      now,
      runAt: new Date(row.run_at),
      enabled: row.enabled,
      status: "pending", // vừa được nhặt từ pending, claimDue đã đảm bảo
      graceMs: cfg.graceMs,
    });

    if (action === "miss") {
      await markRow(sql, row.id, {
        status: "missed",
        last_error: `Trễ quá ${cfg.graceMs / 3600000} tiếng so với giờ hẹn`,
      });
      log(`lịch #${row.id} "${row.name}": BỎ LỠ — trễ quá ngưỡng`);
      // Đây là kiểu hỏng im lặng đúng nghĩa: không job nào fail, không log lỗi,
      // chỉ đơn giản là video không xuất hiện. Không báo thì không ai biết.
      await alertWebhook({
        event: "schedule_missed",
        schedule_id: row.id, name: row.name,
        run_at: row.run_at,
        message: `Bỏ lỡ lịch "${row.name}" — trễ quá ${cfg.graceMs / 3600000} tiếng`,
      });
      continue;
    }

    try {
      const jobId = await enqueueJob(row);
      await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
      log(`lịch #${row.id} "${row.name}": đã đẩy vào hàng đợi (job ${jobId})`);
    } catch (e) {
      await markRow(sql, row.id, { status: "failed", last_error: `Không tạo được job: ${e.message}`.slice(0, 500) });
      log(`lịch #${row.id}: không tạo được job — ${e.message}`);
    }
  }
}

let timer = null;

export function startScheduler({ sql, enqueueJob, log = console.log }) {
  const cfg = schedulerConfig();
  if (timer) return;

  const run = async () => {
    try {
      await tick({ sql, now: new Date(), enqueueJob, log, cfg });
    } catch (e) {
      log(`[scheduler] tick lỗi: ${e.message}`);
    }
  };

  timer = setInterval(run, cfg.tickMs);
  timer.unref?.(); // đừng giữ tiến trình sống chỉ vì bộ đếm giờ
  run();

  log(`[scheduler] tick mỗi ${cfg.tickMs / 1000}s · ngưỡng chạy bù ${cfg.graceMs / 3600000}h · giờ hiện tại ${new Date().toLocaleString("vi-VN")}`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
```

- [ ] **Bước 3: Kiểm tra module nạp được và test cũ vẫn xanh**

Chạy: `npm test`
Mong đợi: PASS — 33 test (Task 1 và 2 không được vỡ vì import mới)

- [ ] **Bước 4: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/scheduler.mjs .env.example
git commit -m "feat(scheduler): vòng tick nhặt dòng đến hạn và đối soát job"
```

---

### Task 6: Route HTTP cho lịch

**Files:**
- Modify: `src/server.mjs`

**Interfaces:**
- Consumes: mọi thứ từ Task 3, 4, 5 · `validateScheduleInput` (Task 2) · `brandFromParams`, `parseStoryboard` (Task 2)
- Produces:
  - `createJobFromSchedule(row) → Promise<string>` — copy file từ `scheduleDir` sang `jobDir`, ghi `status.json`, `enqueue`, trả `job_id`
  - Route: `GET /schedule` · `POST /schedule` · `POST /schedule/:id/toggle` · `POST /schedule/:id/run` · `POST /schedule/:id/delete` · `GET /v1/schedule`

- [ ] **Bước 1: Thêm import vào đầu `src/server.mjs`**

Bổ sung vào khối import đã có:

```js
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { getSql, initSchema } from "./db.mjs";
import { validateScheduleInput } from "./schedule-validate.mjs";
import { brandFromParams, parseStoryboard } from "./storyboard.mjs";
import { createRow, deleteRow, getRow, listRows, markRow, setEnabled } from "./schedule.mjs";
import { lastTick, startScheduler } from "./scheduler.mjs";
import { scheduleDir } from "./store.mjs";
import { probeDuration } from "./adscan.mjs";
```

Lưu ý: `existsSync`, `mkdirSync`, `writeFileSync` đã được import sẵn — chỉ thêm `cpSync`, `readdirSync`, `rmSync`.

- [ ] **Bước 2: Khởi tạo DB và scheduler, ngay dưới `const reaped = reapInterrupted()`**

```js
// ── Bảng lịch ────────────────────────────────────────────────────────────────
const sql = getSql();
await initSchema(sql);
```

Và **sau** khối định nghĩa `enqueue`/`pump` (để `createJobFromSchedule` dùng được `enqueue`):

```js
/**
 * Dựng một job từ dòng lịch: copy file người dùng đã upload sang thư mục job,
 * ghi storyboard từ DB ra file, rồi đẩy vào đúng hàng đợi mà API vẫn dùng.
 *
 * COPY chứ không move: thư mục lịch là nguồn để chạy lại, dọn dẹp job không
 * được làm mất nó.
 */
async function createJobFromSchedule(row) {
  const jobId = newJobId();
  const dir = jobDir(jobId);
  const inputDir = join(dir, "input");
  mkdirSync(join(inputDir, "images"), { recursive: true });

  const src = join(scheduleDir(row.id), "input");
  if (!existsSync(src)) throw new Error(`Không thấy dữ liệu của lịch #${row.id} tại ${src}`);
  cpSync(src, inputDir, { recursive: true });

  writeFileSync(join(inputDir, "storyboard.md"), row.storyboard);

  const { params } = parseStoryboard(row.storyboard);
  const brand = brandFromParams(params);

  writeStatus(jobId, {
    job_id: jobId,
    status: "queued",
    stage: { name: "queued", progress: 0, detail: null },
    template: "vn-news-vertical",
    brand,
    options: {},
    drive: { filename: `${row.name.replace(/[^\p{L}\p{N}]+/gu, "-")}-{date}-{job_id}.mp4` },
    metadata: { schedule_id: row.id, schedule_name: row.name },
    queue_position: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    timings_sec: {},
    warnings: [],
    artifacts: {},
    error: null,
  });

  log(jobId, `job tạo từ lịch #${row.id} "${row.name}"`);
  enqueue(jobId);
  return jobId;
}

startScheduler({ sql, enqueueJob: createJobFromSchedule, log: (m) => console.log(`[scheduler] ${m}`) });
```

- [ ] **Bước 3: Thêm route, đặt trước dòng `serve({...})`**

```js
// ── Lịch tạo video ───────────────────────────────────────────────────────────
app.get("/schedule", async (c) => {
  // plan_source nằm trong status.json của job, không có trong bảng schedule.
  // Ghép vào đây để bảng lịch hiện được cảnh báo "fallback" — dấu hiệu bước
  // LLM không chạy, mà job vẫn báo done.
  const rows = (await listRows(sql)).map((r) => ({
    ...r,
    plan_source: r.job_id ? readStatus(r.job_id)?.plan_source || null : null,
  }));
  return c.html(renderPage.schedule({ rows }));
});

app.get("/v1/schedule", async (c) => c.json({ rows: await listRows(sql) }));

app.post("/schedule", async (c) => {
  const body = await c.req.parseBody({ all: true });

  const name = String(body.name || "").trim();
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();
  const storyboard = String(body.storyboard || "");
  const note = String(body.note || "");
  const enabled = body.enabled === "on";

  if (!name || !date || !time) {
    return c.html(renderPage.scheduleError("Thiếu tên, ngày hoặc giờ"), 400);
  }

  // Giờ nhập là giờ địa phương của server (TZ=Asia/Ho_Chi_Minh).
  const runAt = new Date(`${date}T${time}:00`);
  if (Number.isNaN(runAt.getTime())) {
    return c.html(renderPage.scheduleError("Ngày giờ không hợp lệ"), 400);
  }

  const files = [];
  for (const [k, v] of Object.entries(body)) {
    for (const f of Array.isArray(v) ? v : [v]) {
      if (typeof f === "string" || !f || typeof f.arrayBuffer !== "function") continue;
      files.push({ field: k, file: f });
    }
  }
  const audio = files.find((f) => f.field === "audio");
  if (!audio) return c.html(renderPage.scheduleError("Thiếu file ghi âm"), 400);

  const images = files.filter((f) => f.field === "images" && f.file.name);
  const imageIds = images.map((f) => f.file.name.replace(/\.[a-z0-9]+$/i, ""));

  // Vòng 1 — chỉ storyboard. Chặn sớm để không tạo dòng rác trong DB.
  const early = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec: 0 });
  if (!early.ok) return c.html(renderPage.scheduleError(early.errors.join(" · ")), 400);

  const row = await createRow(sql, { name, runAt, storyboard, note, enabled });

  const inputDir = join(scheduleDir(row.id), "input");
  mkdirSync(join(inputDir, "images"), { recursive: true });
  const write = async (f, dest) => writeFileSync(dest, Buffer.from(await f.arrayBuffer()));

  const ext = (audio.file.name || "vo.mp3").match(/\.[a-z0-9]+$/i)?.[0] || ".mp3";
  const audioPath = join(inputDir, `vo${ext}`);
  await write(audio.file, audioPath);
  for (const im of images) await write(im.file, join(inputDir, "images", im.file.name));

  // Vòng 2 — giờ mới đo được thời lượng audio. Đây là kiểm tra đáng giá nhất:
  // audio không khớp storyboard sẽ ra align_failed sau ~25 phút chạy thật.
  let audioDurationSec = 0;
  try {
    audioDurationSec = await probeDuration(audioPath);
  } catch {
    /* thiếu ffprobe thì bỏ qua kiểm tra này, không chặn người dùng */
  }
  const full = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec });

  if (full.warnings.length) {
    return c.html(renderPage.scheduleSaved({ row, check: full, audioDurationSec }));
  }
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/toggle", async (c) => {
  const row = await getRow(sql, c.req.param("id"));
  if (row) await setEnabled(sql, row.id, !row.enabled);
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/run", async (c) => {
  const row = await getRow(sql, c.req.param("id"));
  if (!row) return c.redirect("/schedule", 303);
  try {
    const jobId = await createJobFromSchedule(row);
    await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
  } catch (e) {
    await markRow(sql, row.id, { status: "failed", last_error: e.message.slice(0, 500) });
  }
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/delete", async (c) => {
  const id = c.req.param("id");
  const row = await getRow(sql, id);
  if (row) {
    // Xoá dòng DB và thư mục file trong cùng một thao tác — đây chính là
    // lý do gộp hai nút thành một: hai nguồn sự thật không được lệch nhau.
    await deleteRow(sql, id);
    rmSync(scheduleDir(id), { recursive: true, force: true });
  }
  return c.redirect("/schedule", 303);
});
```

- [ ] **Bước 4: Phơi mốc tick ra `/health`**

Tick chết thì nó không thể tự báo mình đã chết — phải để giám sát ngoài nhìn vào. Thay
route `/health` hiện có:

```js
app.get("/health", (c) =>
  c.json({ ok: true, running, queued: queue.length, last_tick: lastTick(), now: new Date().toISOString() }),
);
```

Giám sát ngoài (uptime-kuma, cron + curl) so `last_tick` với `now`: cách nhau quá 10 phút
là tiến trình đã treo.

- [ ] **Bước 5: Kiểm tra server khởi động được**

```bash
export DATABASE_URL=postgres://localhost:5432/bantin
export API_TOKEN=test123
npm start
```

Mong đợi: log in ra `bantin-studio: http://localhost:8080` và `[scheduler] tick mỗi 30s ...`

Kiểm tra: `curl -s -H "Authorization: Bearer test123" http://localhost:8080/v1/schedule`
Mong đợi: `{"rows":[]}`

Kiểm tra: `curl -s http://localhost:8080/health`
Mong đợi: có trường `last_tick` với mốc ISO, không phải `null`

- [ ] **Bước 6: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/server.mjs
git commit -m "feat(server): route quản lý lịch và tạo job từ dòng lịch"
```

---

### Task 7: Trang UI `/schedule`

**Files:**
- Modify: `src/ui.mjs`

**Interfaces:**
- Consumes: `Row` từ Task 4
- Produces: `renderPage.schedule({ rows }) → string` · `renderPage.scheduleError(message) → string`

- [ ] **Bước 1: Thêm nhãn trạng thái vào đầu `src/ui.mjs`**

Ngay dưới `STATUS_LABEL` đã có:

```js
const SCHEDULE_LABEL = {
  pending: "🕐 Chờ đến giờ",
  claimed: "⏱ Đang nhận",
  queued: "📋 Trong hàng đợi",
  running: "⏳ Đang chạy",
  done: "✅ Xong",
  failed: "❌ Lỗi",
  missed: "⚠️ Bỏ lỡ",
};

const fmtDate = (d) => new Date(d).toLocaleDateString("vi-VN");
const fmtTime = (d) => new Date(d).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
```

- [ ] **Bước 2: Thêm CSS cho trang lịch, nối vào cuối biến `CSS` đã có**

```css
nav{display:flex;gap:18px;padding:0 24px 12px;border-bottom:1px solid var(--line)}
nav a{color:var(--dim);text-decoration:none;font-size:14px;padding:6px 0}
nav a.on{color:var(--fg);box-shadow:inset 0 -2px 0 var(--red)}
form.inline{display:inline}
.sw{background:none;border:0;cursor:pointer;font-size:15px;padding:2px 6px}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;color:var(--dim);margin-bottom:5px}
.field input,.field textarea{width:100%;background:#0e1116;border:1px solid var(--line);
  border-radius:6px;color:var(--fg);padding:8px 10px;font:inherit}
.field textarea{min-height:150px;font-family:ui-monospace,monospace;font-size:13px}
.row2{display:flex;gap:14px}.row2>*{flex:1}
.err{background:#3a1416;border:1px solid var(--red);border-radius:8px;padding:14px;margin-bottom:18px}
```

- [ ] **Bước 3: Thêm `page()` và `nav()` — đặt ngay trên `export const renderPage`**

`ui.mjs` hiện chưa có hàm bao trang dùng chung: `dashboard()` nội tuyến cả khối `<html>`.
Thêm hàm này cho hai trang mới dùng, **không sửa `dashboard()`** — tránh đụng vào trang
đang chạy tốt.

Import ở đầu file (`hono` đã cài sẵn, không thêm dependency):

```js
import { html, raw } from "hono/html";
```

```js
/**
 * Khung trang dùng chung cho các trang mới. Dùng `html` của hono thay cho nối
 * chuỗi: nội suy được escape mặc định, muốn chèn HTML thô phải nói rõ raw().
 * dashboard() giữ nguyên cách cũ — chuyển dần, không đập đi làm lại.
 */
function page(inner) {
  return html`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bản tin Studio</title><style>${raw(CSS)}</style>
</head><body>
<header><span class="pill">BẢN TIN</span><h1>Studio</h1></header>
${inner}
</body></html>`;
}

function nav(active) {
  const item = (href, label) =>
    html`<a href="${href}" class="${href === active ? "on" : ""}">${label}</a>`;
  return html`<nav>${item("/", "Video")}${item("/schedule", "Lịch")}</nav>`;
}
```

- [ ] **Bước 4: Thêm ba hàm render vào object `renderPage`**

```js
  schedule({ rows }) {
    const body = rows.length === 0
      ? html`<div class="empty">Chưa có lịch nào. Bấm “+ Thêm lịch” để tạo.</div>`
      : html`<table>
          <thead><tr>
            <th>ID</th><th>Ngày</th><th>Giờ</th><th>Tên</th>
            <th>Chạy?</th><th>Trạng thái</th><th></th>
          </tr></thead>
          <tbody>${rows.map(scheduleRow)}</tbody>
         </table>`;

    return page(html`
      ${nav("/schedule")}
      <main>
        <h2>Lịch tạo video
          <button class="btn primary" style="float:right"
                  onclick="document.getElementById('add').showModal()">+ Thêm lịch</button>
        </h2>
        ${body}
        ${addDialog()}
      </main>`);
  },

  scheduleError(message) {
    return page(html`
      ${nav("/schedule")}
      <main>
        <div class="err"><strong>Không lưu được</strong><br />${message}</div>
        <a class="btn" href="/schedule">← Quay lại</a>
      </main>`);
  },

  /** Đã lưu nhưng có cảnh báo — hiện ra để người dùng quyết định, không tự chặn. */
  scheduleSaved({ row, check, audioDurationSec }) {
    return page(html`
      ${nav("/schedule")}
      <main>
        <h2>Đã lưu lịch #${row.id} — nhưng có cảnh báo</h2>
        <div class="err">
          <ul>${check.warnings.map((w) => html`<li>${w}</li>`)}</ul>
        </div>
        <div class="card mono">
          ${check.lineCount} dòng lời thoại ·
          ${check.referencedImages.length} ảnh được tham chiếu ·
          file ghi âm ${Math.round(audioDurationSec)}s
        </div>
        <p>Lịch đã được lưu. Sửa lại hoặc xoá nếu thấy sai.</p>
        <a class="btn primary" href="/schedule">← Về danh sách</a>
      </main>`);
  },
```

- [ ] **Bước 5: Thêm các hàm phụ trợ, đặt cạnh `nav()`**

```js
function scheduleRow(r) {
  let detail = "";
  if (r.status === "done" && r.video_link) {
    detail = html` · <a href="${r.video_link}" target="_blank" rel="noopener">mở video</a>`;
  } else if (r.last_error) {
    detail = html` · <span class="warn">${String(r.last_error).slice(0, 90)}</span>`;
  }

  // Bố cục fallback nghĩa là bước LLM không chạy — video vẫn ra nhưng nghèo hẳn.
  // Ở chế độ tự động không ai xem lại từng video, nên phải hiện ra ở đây.
  const plan = r.plan_source === "fallback" ? html` <span class="warn">fallback</span>` : "";

  const post = (path, label, title) => html`
    <form class="inline" method="post" action="/schedule/${r.id}/${path}">
      <button class="btn" title="${title}">${label}</button></form>`;

  return html`<tr>
    <td class="mono">${r.id}</td>
    <td>${fmtDate(r.run_at)}</td>
    <td>${fmtTime(r.run_at)}</td>
    <td>${r.name}</td>
    <td><form class="inline" method="post" action="/schedule/${r.id}/toggle">
          <button class="sw" title="${r.enabled ? "Đang bật — bấm để tắt" : "Đang tắt — bấm để bật"}">
            ${r.enabled ? "🟢" : "⚪"}</button></form></td>
    <td>${SCHEDULE_LABEL[r.status] || r.status}${detail}${plan}</td>
    <td style="text-align:right;white-space:nowrap">
      ${post("run", "Chạy ngay", "Bỏ qua giờ hẹn, đẩy vào hàng đợi luôn")}
      ${post("delete", "Xoá", "Xoá cả dòng lịch lẫn file đã upload")}
    </td>
  </tr>`;
}

function addDialog() {
  return html`<dialog id="add">
    <form method="post" action="/schedule" enctype="multipart/form-data">
      <div class="head"><strong>Thêm lịch</strong>
        <button type="button" class="btn" style="margin-left:auto"
                onclick="document.getElementById('add').close()">Đóng</button></div>
      <div class="body">
        <div class="field"><label>Tên</label><input name="name" required placeholder="Tin tức vàng" /></div>
        <div class="row2">
          <div class="field"><label>Ngày</label><input type="date" name="date" required /></div>
          <div class="field"><label>Giờ</label><input type="time" name="time" required value="09:00" /></div>
        </div>
        <div class="field"><label>Storyboard (dán bảng markdown)</label>
          <textarea name="storyboard" required placeholder="| # | Thời điểm | Lời thoại | ..."></textarea></div>
        <div class="field"><label>File ghi âm</label>
          <input type="file" name="audio" accept="audio/*" required /></div>
        <div class="field"><label>Hình ảnh (đặt tên file trùng id trong storyboard, vd image_1.png)</label>
          <input type="file" name="images" accept="image/*" multiple /></div>
        <div class="field"><label>Ghi chú</label><input name="note" /></div>
        <div class="field"><label><input type="checkbox" name="enabled" checked /> Bật ngay</label></div>
        <button class="btn primary" type="submit">Lưu lịch</button>
      </div>
    </form>
  </dialog>`;
}
```

> **Vì sao không dùng `esc()` trong khối trên:** `html` của hono escape mọi giá trị nội
> suy sẵn. Gọi thêm `esc()` sẽ escape hai lần — dấu `&` trong tên hiện thành `&amp;`.

- [ ] **Bước 6: Kiểm tra bằng mắt**

```bash
npm start
```

Mở `http://localhost:8080/schedule?token=test123`. Kiểm:
- Thanh điều hướng có 2 mục, mục "Lịch" được gạch chân đỏ
- Bấm "+ Thêm lịch" mở hộp thoại
- Tạo một dòng với ngày giờ trong quá khứ 5 phút → sau ≤ 30 giây trạng thái đổi sang `📋 Trong hàng đợi`
- Bấm 🟢 → chuyển ⚪, dòng không bị nhặt nữa
- Tạo một dòng có storyboard 5 dòng thoại nhưng audio dài 15 phút → phải ra **trang cảnh
  báo lệch thời lượng**, và lịch vẫn được lưu
- Đặt tên lịch có ký tự `&` và `<` → bảng phải hiện đúng nguyên văn, không thành `&amp;`

- [ ] **Bước 7: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/ui.mjs
git commit -m "feat(ui): trang lịch tạo video với form upload và validate"
```

---

### Task 8: Cài đặt `JOB_TIMEOUT_MS`

`JOB_TIMEOUT_MS` đang có trong `.env.example` nhưng **không dòng code nào đọc**. Chỉ bước gọi `claude` có timeout riêng; ffmpeg, `transcribe.py`, `hyperframes render` và `fetch` upload Drive đều không có gì chặn. Ở chế độ hẹn giờ, một job treo làm mọi dòng lịch phía sau lần lượt chuyển sang `missed`.

**Files:**
- Modify: `src/server.mjs` (hàm `pump`)
- Modify: `.env.example` (đổi giá trị mặc định)

**Interfaces:** không đổi giao diện công khai.

- [ ] **Bước 1: Nâng mặc định trong `.env.example`**

Đổi dòng đã có:

```bash
# Trần thời gian một job (ms). 120 phút — job bình thường tốn 45-70 phút,
# để quá sát sẽ giết cả job đang chạy đúng.
JOB_TIMEOUT_MS=7200000
```

- [ ] **Bước 2: Thay thân hàm `pump` trong `src/server.mjs`**

Thay khối `try/catch/finally` hiện tại bằng:

```js
  const timeoutMs = Number(process.env.JOB_TIMEOUT_MS || 7_200_000);
  let timedOut = false;
  let timer = null;

  try {
    const job = runJob(jobId, { registerChild: (c) => kids.add(c) });
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // Dùng lại đúng cơ chế của nút Huỷ: giết tiến trình con để runJob
        // thoát ra, rồi ghi đè trạng thái bằng mã "timeout".
        for (const child of kids) {
          try { child.kill("SIGTERM"); } catch { /* có thể đã chết */ }
        }
        setTimeout(() => {
          for (const child of kids) {
            try { child.kill("SIGKILL"); } catch { /* đã chết */ }
          }
        }, 10_000);
        reject(new Error("timeout"));
      }, timeoutMs);
    });

    await Promise.race([job, guard]);

    if (timedOut) await job.catch(() => {}); // để runJob dọn xong đã
  } catch (e) {
    if (!timedOut) console.error(`[job ${jobId}]`, e);
  } finally {
    if (timer) clearTimeout(timer);

    if (timedOut) {
      // Ghi SAU khi runJob settle, nếu không nó sẽ đè lại bằng render_failed.
      patchStatus(jobId, {
        status: "failed",
        stage: { name: "failed", progress: null, detail: null },
        error: {
          code: "timeout",
          stage: "unknown",
          message: `Job vượt trần ${Math.round(timeoutMs / 60000)} phút — đã dừng để giải phóng hàng đợi`,
          retryable: false,
        },
      });
      log(jobId, `FAILED [timeout] quá ${Math.round(timeoutMs / 60000)} phút`);
    }

    children.delete(jobId);
    running = null;
    setImmediate(pump);
  }
```

- [ ] **Bước 3: Kiểm tra bằng giá trị nhỏ**

```bash
JOB_TIMEOUT_MS=5000 DATABASE_URL=postgres://localhost:5432/bantin API_TOKEN=test123 npm start
```

Tạo một job bất kỳ (qua `POST /v1/jobs` hoặc nút "Chạy ngay"). Sau ~5 giây:

```bash
curl -s -H "Authorization: Bearer test123" http://localhost:8080/v1/jobs/<id> | grep -o '"code":"[^"]*"'
```

Mong đợi: `"code":"timeout"` — và hàng đợi nhấc được job kế tiếp thay vì đứng im.

- [ ] **Bước 4: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/server.mjs .env.example
git commit -m "fix(server): JOB_TIMEOUT_MS thực sự hoạt động, không để job treo chặn hàng đợi"
```

---

### Task 9: Timeout upload Drive và dọn `work/`

Không có bước dọn thì 3 video/ngày ≈ 1,2 GB/ngày, đầy 100 GB sau ~3 tháng — và khi đĩa đầy thì mọi dòng lịch sau đó đều hỏng.

**Files:**
- Modify: `src/drive.mjs`
- Modify: `src/pipeline.mjs`

**Interfaces:**
- Produces: `cleanupAfterUpload(dir, log) → number` (số byte đã giải phóng) trong `pipeline.mjs`

- [ ] **Bước 1: Thêm timeout cho `fetch` trong `src/drive.mjs`**

Vòng retry 3 lần hiện có **chỉ chạy khi `fetch` ném lỗi**. Kết nối treo thì không ném gì cả, nên retry không bao giờ được kích hoạt. Thêm `AbortSignal.timeout` biến treo thành lỗi ném ra:

Trong `getAccessToken`, thêm vào object tuỳ chọn của `fetch`:

```js
    signal: AbortSignal.timeout(30_000),
```

Trong `uploadToDrive`, thêm vào lời gọi `fetch(UPLOAD_URL, {...})`:

```js
    signal: AbortSignal.timeout(30_000),
```

Và vào lời gọi `fetch(session, {...})` bên trong vòng retry:

```js
          signal: AbortSignal.timeout(120_000), // 8 MB qua đường truyền chậm vẫn kịp
```

- [ ] **Bước 2: Thêm hàm dọn vào `src/pipeline.mjs`**

Thêm `rmSync` và `statSync` vào import `node:fs` đã có, rồi thêm hàm này trên `runJob`:

```js
/**
 * Video đã an toàn trên Drive thì các file nặng trong thư mục job không còn
 * giá trị. Giữ lại status.json, logs.ndjson, transcript.json, chapters.json
 * (vài trăm KB) để còn tra cứu.
 *
 * CHỈ gọi khi upload Drive THÀNH CÔNG — nếu không thì đây là bản sao duy nhất.
 */
function cleanupAfterUpload(dir, onLog = () => {}) {
  const targets = [
    "output.mp4", "vo.mp3", "vo16k.wav", "vo-cut.mp3", "vo-final.mp3",
    "project", "input",
  ];

  let freed = 0;
  for (const name of targets) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      freed += dirSize(p);
      rmSync(p, { recursive: true, force: true });
    } catch (e) {
      onLog(`không xoá được ${name}: ${e.message}`);
    }
  }
  onLog(`dọn ${(freed / 1048576).toFixed(0)} MB (video đã an toàn trên Drive)`);
  return freed;
}

function dirSize(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + dirSize(join(p, f)), 0);
}
```

- [ ] **Bước 3: Gọi hàm dọn sau khi upload thành công**

Trong bước 10 của `runJob`, ngay **sau** dòng `log(jobId, \`Drive: ${file.webViewLink}\`);`:

```js
      cleanupAfterUpload(dir, (m) => log(jobId, m));
```

- [ ] **Bước 4: Trỏ `video_url` sang Drive khi file local đã bị xoá**

Trong khối `patchStatus` cuối `runJob`, đổi dòng `video_url`:

```js
        // File local đã bị dọn sau khi upload — trỏ thẳng sang Drive.
        video_url: drive.link || `/v1/jobs/${jobId}/video`,
```

- [ ] **Bước 5: Kiểm tra**

Chạy một job có cấu hình Drive đầy đủ. Sau khi xong:

```bash
ls work/<job_id>/
du -sh work/<job_id>/
```

Mong đợi: chỉ còn `status.json`, `logs.ndjson`, `transcript.json`, `chapters.json`, `chapters.src.json`, `asr.json` — dưới 5 MB. Không có `output.mp4`, không có `project/`, không có `input/`.

Chưa cấu hình Drive thì **không được xoá gì** — kiểm tra lại bằng cách bỏ `GOOGLE_REFRESH_TOKEN` và chạy lại: `output.mp4` phải còn nguyên.

- [ ] **Bước 6: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add src/drive.mjs src/pipeline.mjs
git commit -m "fix: timeout cho upload Drive và dọn file nặng sau khi upload xong"
```

---

### Task 10: Cấu hình vận hành

**Files:**
- Modify: `Dockerfile`
- Modify: `scripts/doctor.mjs`

**Interfaces:** không có.

- [ ] **Bước 1: Thêm `TZ` và `claude` CLI vào `Dockerfile`**

Thêm `tzdata` vào danh sách `apt-get install`:

```dockerfile
      ffmpeg python3 python3-pip ca-certificates curl tzdata \
```

Sau dòng `RUN npm install --omit=dev`, thêm:

```dockerfile
# Bước planning gọi `claude` như một chương trình ngoài. Không cài thì mọi job
# rơi về bố cục fallback mà VẪN báo "done" — kiểu hỏng im lặng khó phát hiện
# nhất. Cần thêm ANTHROPIC_API_KEY lúc chạy để nó xác thực được.
RUN npm install -g @anthropic-ai/claude-code
```

Đổi dòng `ENV`:

```dockerfile
ENV WORK_DIR=/data PORT=8080 TZ=Asia/Ho_Chi_Minh
```

- [ ] **Bước 2: Thêm `ANTHROPIC_API_KEY` vào `.env.example`**

Trong khối `# ── Claude Code ──` đã có, thêm ngay dưới `CLAUDE_BIN`:

```bash
# Xác thực cho `claude` trên server. Máy cá nhân đăng nhập bằng subscription
# (credential nằm trong ~/.claude/) — thứ đó KHÔNG đi theo Docker image.
# Thiếu key này thì mọi video đều dùng bố cục fallback mà job vẫn báo "done".
ANTHROPIC_API_KEY=
```

- [ ] **Bước 3: Mở rộng `scripts/doctor.mjs`**

Thay dòng kiểm tra `claude` hiện tại (`const claude = await has(...)`) bằng:

```js
// `claude --version` chạy được KỂ CẢ khi chưa xác thực — nên nó không chứng
// minh được gì. Phải gọi thật một lần mới biết.
const claudeBin = process.env.CLAUDE_BIN || "claude";
const claudeVer = await has(claudeBin);
if (!claudeVer) {
  warn(`${claudeBin} không có trên PATH — pipeline sẽ luôn dùng bố cục fallback`);
} else {
  try {
    const { stdout } = await pexec(claudeBin, ["-p", "--output-format", "json"], {
      input: "Trả lời đúng một mảng JSON: [1,2,3]",
      timeout: 60000,
    });
    JSON.parse(stdout);
    ok(`claude: ${claudeVer} — xác thực OK`);
  } catch {
    bad(`claude: ${claudeVer} nhưng GỌI THẬT THẤT BẠI — kiểm tra ANTHROPIC_API_KEY. Mọi video sẽ dùng bố cục fallback.`);
  }
}
```

Và thêm vào khối `Cấu hình:`:

```js
if (process.env.DATABASE_URL) {
  try {
    const { getSql, initSchema, closeSql } = await import("../src/db.mjs");
    await initSchema(getSql());
    await closeSql();
    ok("PostgreSQL kết nối được, bảng schedule sẵn sàng");
  } catch (e) {
    bad(`PostgreSQL lỗi: ${e.message}`);
  }
} else {
  bad("DATABASE_URL trống — bảng lịch sẽ không chạy");
}

// Múi giờ sai là bẫy kinh điển: VPS mặc định UTC, hẹn 09:00 thì video ra lúc 16:00.
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const nowLocal = new Date().toLocaleString("vi-VN");
tz === "Asia/Ho_Chi_Minh"
  ? ok(`múi giờ ${tz} — bây giờ là ${nowLocal}`)
  : warn(`múi giờ ${tz} (không phải Asia/Ho_Chi_Minh) — bây giờ là ${nowLocal}. Kiểm tra kỹ trước khi tin vào giờ hẹn.`);
```

- [ ] **Bước 4: Kiểm tra**

Chạy: `npm run doctor`

Mong đợi: in thêm 3 dòng — trạng thái xác thực `claude`, kết nối PostgreSQL, và múi giờ kèm giờ hiện tại để đối chiếu bằng mắt.

- [ ] **Bước 5: Commit** *(commit trên nhánh feat/, KHÔNG push)*

```bash
git add Dockerfile scripts/doctor.mjs .env.example
git commit -m "chore: TZ, claude CLI trong image, doctor kiểm tra DB và xác thực thật"
```

---

## Kiểm tra cuối cùng

Sau khi xong 10 task:

- [ ] `npm test` — 33 test pass (17 hàm thuần + 16 tầng DB)
- [ ] `npm run doctor` — không có dòng ✗
- [ ] Tạo một lịch hẹn 2 phút nữa, có đủ storyboard + audio khớp nhau + ảnh
- [ ] Chờ tick nhặt → theo dõi trạng thái đi qua `queued` → `running` → `done`
- [ ] Video xuất hiện trong thư mục Drive, cột Trạng thái hiện link
- [ ] `ls work/<job_id>/` — đã dọn, không còn `output.mp4` và `project/`
- [ ] Kiểm tra `plan_source` trong `status.json` là `"llm"` chứ không phải `"fallback"`
- [ ] Tắt một dòng lịch quá hạn → xác nhận nó không bị nhặt
- [ ] Đặt `SCHEDULE_GRACE_HOURS=0`, tạo dòng quá hạn 1 phút → phải thành `missed`
