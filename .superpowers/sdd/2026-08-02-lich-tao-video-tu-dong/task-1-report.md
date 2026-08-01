# Task 1 Report: Hàm quyết định thuần

## Tổng kết
✅ **DONE** — 6 bước TDD hoàn thành, 10/10 tests pass, code committed.

## Files được tạo/sửa

1. **`package.json`** — Thêm script test:
   ```json
   "test": "node --test \"test/**/*.test.mjs\""
   ```
   (Sửa lại từ hard-code file sang glob pattern — xem phần Sửa chữa sau review)

2. **`src/scheduler.mjs`** (tạo mới)
   - Export hàm `decideAction(...)` quyết định: run | wait | miss
   - Export hàm `isRetryable(...)` phân loại lỗi có nên retry
   - Export `RETRYABLE_CODES` Set chứa ["interrupted", "render_failed", "internal_error"]
   - 34 dòng code + comment

3. **`test/scheduler.test.mjs`** (tạo mới)
   - 10 test case kiểm tra:
     - `decideAction`: 6 test (chưa tới giờ, đúng giờ, trễ bù, quá hạn, tắt, trạng thái khác)
     - `isRetryable`: 4 test (lỗi tạm thời, lỗi dữ liệu, hết lượt, code rỗng/lạ)
   - 99 dòng code

## Kết quả chạy test

```
> auto-news-video@0.1.0 test
> node --test test/scheduler.test.mjs

✔ decideAction: chưa tới giờ thì chờ (2.1305ms)
✔ decideAction: đúng giờ thì chạy (1.6288ms)
✔ decideAction: trễ trong ngưỡng thì vẫn chạy bù (0.368ms)
✔ decideAction: trễ quá ngưỡng thì bỏ lỡ (0.3365ms)
✔ decideAction: tắt thì luôn chờ, kể cả quá hạn (0.2668ms)
✔ decideAction: trạng thái không phải pending thì không đụng tới (0.3158ms)
✔ isRetryable: lỗi tạm thời thì thử lại (0.2268ms)
✔ isRetryable: lỗi dữ liệu thì dừng (0.1621ms)
✔ isRetryable: hết lượt thì dừng dù lỗi tạm thời (0.3007ms)
✔ isRetryable: code rỗng hoặc lạ thì dừng (0.5489ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 138.5184
```

**Kết quả: 10/10 pass ✅**

## Quyết định tự đưa ra

### 1. Script test trong package.json (sửa sau review)
Brief ghi `"test": "node --test test/"` nhưng trên Windows, `node --test` không nhận diện được thư mục theo cách đó. Ban đầu hard-code thành `"test": "node --test test/scheduler.test.mjs"`.

**Vấn đề phát hiện**: Dạng hard-code sẽ làm Task 2 và Task 4 (test file khác) bị im lặng bỏ qua — `npm test` vẫn báo xanh nhưng test mới không chạy. Đây là lỗi tệ nhất (trông như pass nhưng thực ra không kiểm tra).

**Sửa lại**: Dùng glob pattern `"test": "node --test \"test/**/*.test.mjs\""` — đã kiểm chứng trên máy này, 10/10 pass với pattern này.

### 2. Không thêm dependency
Theo yêu cầu không thêm dependency, code chỉ dùng `node:test` và `node:assert/strict` có sẵn.

## Bất kỳ điều gì khiến nghi ngờ

**Không có**. Code đơn giản, test đầy đủ, tất cả pass. Git warnings về CRLF/LF là bình thường trên Windows và không ảnh hưởng chức năng.

## Commit
```
f8cbce6 feat(scheduler): hàm quyết định chạy/bù/bỏ lỡ và phân loại lỗi
```

Commit được lưu tại local trên nhánh `feat/lich-tao-video-tu-dong`, không push (remote chỉ có `main`).

## Bước TDD đã hoàn thành
- ✅ Bước 1: Thêm script test
- ✅ Bước 2: Viết test
- ✅ Bước 3: Xác nhận test FAIL (Cannot find module 'scheduler.mjs')
- ✅ Bước 4: Viết implementation
- ✅ Bước 5: Xác nhận test PASS (10/10)
- ✅ Bước 6: Git commit

---

## Sửa chữa sau review

### Critical: Script test hard-code lỗi
Coordinator phát hiện script hard-code file `test/scheduler.test.mjs` sẽ làm Task 2 và Task 4 bị im lặng không chạy. Sửa lại thành glob pattern:

```json
"test": "node --test \"test/**/*.test.mjs\""
```

Chạy `npm test` xác nhận:
```
> auto-news-video@0.1.0 test
> node --test "test/**/*.test.mjs"

✔ decideAction: chưa tới giờ thì chờ (4.7182ms)
✔ decideAction: đúng giờ thì chạy (2.6423ms)
✔ decideAction: trễ trong ngưỡng thì vẫn chạy bù (0.62ms)
✔ decideAction: trễ quá ngưỡng thì bỏ lỡ (0.4949ms)
✔ decideAction: tắt thì luôn chờ, kể cả quá hạn (0.5188ms)
✔ decideAction: trạng thái không phải pending thì không đụng tới (0.4608ms)
✔ isRetryable: lỗi tạm thời thì thử lại (0.3998ms)
✔ isRetryable: lỗi dữ liệu thì dừng (0.3946ms)
✔ isRetryable: hết lượt thì dừng dù lỗi tạm thời (0.622ms)
✔ isRetryable: code rỗng hoặc lạ thì dừng (0.8688ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 276.5655
```

**Kết quả: vẫn 10/10 pass ✅**

### Important: Báo cáo sai về push
Báo cáo ghi "Commit được push lên nhánh" nhưng thực ra commit chỉ ở local. Remote chỉ có `main`, nhánh `feat/lich-tao-video-tu-dong` không tồn tại trên remote. Sửa lại dòng Commit thành "Commit được lưu tại local, không push".
