# Image chạy trọn pipeline: Node + Python + ffmpeg + Chrome cho hyperframes.
FROM node:22-bookworm-slim

# Chrome headless cần bộ thư viện hệ thống này; ffmpeg để cắt/pad audio;
# python3 cho faster-whisper. fonts-* để render tiếng Việt không bị ô vuông.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates curl tzdata \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

COPY package.json ./
RUN npm install --omit=dev

# Bước planning gọi `claude` như một chương trình ngoài. Không cài thì mọi job
# rơi về bố cục fallback mà VẪN báo "done" — kiểu hỏng im lặng khó phát hiện
# nhất. Cần thêm ANTHROPIC_API_KEY lúc chạy để nó xác thực được.
RUN npm install -g @anthropic-ai/claude-code

COPY src ./src
COPY scripts ./scripts
COPY templates ./templates

# Tải sẵn Chrome + CLI vào image. Không làm bước này thì job đầu tiên phải chờ
# npx tải ~200 MB, và container không có mạng ra ngoài sẽ hỏng thẳng.
ARG HYPERFRAMES_VERSION=0.7.86
ENV HYPERFRAMES_VERSION=${HYPERFRAMES_VERSION}
RUN npx --yes hyperframes@${HYPERFRAMES_VERSION} doctor || true

# Nạp sẵn model whisper để job đầu không phải tải ~3 GB.
ARG WHISPER_MODEL=large-v3
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')" || true

ENV WORK_DIR=/data PORT=8080 TZ=Asia/Ho_Chi_Minh
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["node", "src/server.mjs"]
