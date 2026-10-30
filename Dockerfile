# 后端镜像：跑 Fastify + 本地 SQLite。数据落在挂载到 /data 的磁盘上。
# Vercel 只做静态页和 /api 转发，真正的进程和数据库在这里。
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY . .

# 免费档没有挂载盘，/data 就在容器里；先建好目录，seed 才能写库。
RUN mkdir -p /data/audio

ENV MIANYAN_DEMO_MODE=1 \
    MIANYAN_HOST=0.0.0.0 \
    MIANYAN_PORT=10000 \
    MIANYAN_DB_PATH=/data/mianyan.db \
    MIANYAN_AUDIO_DIR=/data/audio \
    MIANYAN_COOKIE_SECURE=1

EXPOSE 10000

# 第一次启动时把演示库生成到磁盘上；之后重启直接复用，不会覆盖已有数据。
CMD ["sh", "-c", "if [ ! -f \"$MIANYAN_DB_PATH\" ]; then npx tsx packages/core/src/scripts/seed.ts; fi; exec npx tsx apps/server/src/main.ts"]
