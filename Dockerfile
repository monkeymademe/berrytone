FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8083 \
    MUSIC_DIR=/music \
    DATA_DIR=/data \
    SCAN_CONCURRENCY=3

RUN mkdir -p /music /data \
    && chown -R node:node /data

EXPOSE 8083

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8083) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
