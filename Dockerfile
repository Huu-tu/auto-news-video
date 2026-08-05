FROM node:22-bookworm-slim

RUN export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates curl tzdata unzip \
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

RUN npm install -g @anthropic-ai/claude-code

COPY src ./src
COPY scripts ./scripts
COPY templates ./templates

ARG HYPERFRAMES_VERSION=0.7.86
ENV HYPERFRAMES_VERSION=${HYPERFRAMES_VERSION}
RUN npx --yes hyperframes@${HYPERFRAMES_VERSION} browser ensure \
    && npx --yes hyperframes@${HYPERFRAMES_VERSION} browser path

ARG WHISPER_MODEL=large-v3
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

ENV HF_HUB_OFFLINE=1

ENV WORK_DIR=/data PORT=8080 TZ=Asia/Ho_Chi_Minh
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["node", "src/server.mjs"]
