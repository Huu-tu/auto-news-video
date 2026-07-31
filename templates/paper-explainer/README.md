# Template: Paper Explainer (giấy cắt xếp lớp, 9:16)

Template dựng video **tin tức và chia sẻ kiến thức** theo phong cách giấy cắt xếp lớp:
mỗi cảnh là một tờ giấy được đặt xuống tấm bìa kraft, có tab hồ sơ, mép cắt tay và
bóng đổ tạo độ dày. Dọc 1080×1920, toàn bộ hình là chữ và đồ họa.

Dùng chung hợp đồng dữ liệu với `vn-news-vertical` (transcript + chapters + audio) và
**cùng bộ 10 loại cảnh**, nên chạy được ngay với pipeline hiện có: chỉ cần đổi
`payload.template` thành `paper-explainer` khi gọi `POST /v1/jobs`.

## Hệ thống hình ảnh

| Lớp | Quyết định |
|---|---|
| Bảng màu | Hai mực risograph trên bìa kraft — xanh `#2c5c86` + hoàng thổ `#d99a34`. Cố ý tránh combo cream + terracotta vốn quá quen thuộc. |
| Chữ tiêu đề | **Montserrat 900** — nét dày, đọc như cắt bằng kéo |
| Chữ thân | **Inter** |
| Nhãn, số liệu | **JetBrains Mono** — chất nhà in, sổ ghi chép |
| Cấu trúc | **Tab hồ sơ** nhô khỏi mép trên mỗi thẻ, mang tên chuyên mục — mã hoá "đang ở ngăn nào của bài", không phải trang trí |
| Ký hiệu riêng | **Chữ khoét thủng** ở intro và thẻ ngăn: chữ mang màu bìa kraft, bóng đổ trong lòng nét, đọc như cắt xuyên qua giấy |
| Chuyển động | Tờ giấy **được đặt xuống**: hạ 26px, xoay nhẹ ±0.9°, thu 1.03 → 1 |

Ba font trên đều nằm trong danh sách renderer tự cấp được **và** có đủ ký tự tiếng Việt.
Đổi font khác phải kiểm tra cả hai điều kiện — xem mục bẫy bên dưới.

## Loại cảnh

Giống hệt `vn-news-vertical`: `intro`, `divider`, `headline`, `story`, `stat`, `chart`,
`image`, `tiles`, `quote`, `keys`. Xem `../vn-news-vertical/README.md` để biết field của
từng loại.

## Đổi giao diện nhanh (sửa `paper.css`)

- Màu: sửa biến trong `:root` — `--board`, `--stock`, `--riso-blue`, `--ochre`
- Độ sâu vết cắt: `--board-deep` và `text-shadow` trong `.cutout`
- Mép cắt tay: 4 biến thể `.sheet.c0` … `.c3`, luân phiên theo chỉ số cảnh (cố định nên
  seek ổn định, không dùng random)
- Hạt giấy: `.grain` (SVG feTurbulence nội tuyến, tất định)

## Ba bẫy đã vấp khi dựng template này

**1. Thứ tự vẽ CSS — lỗi khó thấy nhất.** `.underlay` là `position: absolute` nên theo
thứ tự vẽ của CSS nó nằm **trên** mọi phần tử tĩnh cùng cấp. Phần tử nào được GSAP gắn
`transform` sẽ tự tạo stacking context nên vẫn nổi lên — vì vậy lỗi chỉ lộ ra ở phần tử
KHÔNG animate (nhãn biểu đồ) hoặc chỉ animate `opacity` (số trên cột): chúng biến mất
lặng lẽ, không báo lỗi gì. Đã chặn bằng `.sheet > *:not(.underlay) { position: relative }`.

**2. Font thiếu ký tự tiếng Việt.** Archivo Black và Space Mono không có bộ chữ Việt →
trình duyệt thay glyph từng ký tự, chữ vỡ ngay giữa từ ("Tuyến" một nét, "đường" nét
khác). Font phải vừa có tiếng Việt vừa nằm trong danh sách renderer tự cấp; ngoài danh
sách đó thì `hyperframes lint` báo `font_family_without_font_face`.

**3. `clip-path` cắt cả phần con cố tình tràn ra ngoài.** Tab hồ sơ ban đầu nằm trong
`.sheet` nên bị mép cắt xén mất. Phải để tab làm **anh em** của `.sheet`, trong `.card`.

## Kiểm tra sau khi sửa

```bash
node templates/paper-explainer/build.mjs --out <proj> --audio <mp3> \
     --transcript <transcript.json> --chapters <chapters.json> \
     --brand "GÓC NHÌN" --brand-sub "KIẾN THỨC" --date "27 · 07"
cd <proj>
npx hyperframes lint                                   # phải 0 lỗi
npx hyperframes snapshot --at 3,14,32,55 -o shots      # soi frame trước khi render
```

`snapshot --zoom "<selector>"` phóng to một vùng — cách nhanh nhất để tìm phần tử bị mất.
