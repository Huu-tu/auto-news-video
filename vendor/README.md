# vendor/

Bản dự phòng của CLI HyperFrames.

Pipeline bình thường gọi `npx --yes hyperframes@<HYPERFRAMES_VERSION>` — tải từ npm mỗi
lần chạy. Repo này không còn chứa source framework, nên nếu npm sập, version bị gỡ, hoặc
VPS không ra được internet thì không có gì thay thế.

Tarball ở đây là bản chốt cứng, cài offline:

```bash
npm install -g ./vendor/hyperframes-0.7.86.tgz
```

Cài xong thì `hyperframes` có sẵn trên PATH; đổi lệnh trong `src/pipeline.mjs` từ
`npx --yes hyperframes@…` sang `hyperframes` là chạy hoàn toàn offline (trừ font Google
Fonts mà compiler tải về `~/.cache/hyperframes/fonts` — Dockerfile đã pre-warm sẵn).

Nâng version: đổi `HYPERFRAMES_VERSION` trong `.env`, rồi
`npm pack hyperframes@<version> --pack-destination vendor` và xoá tarball cũ.
