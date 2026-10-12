# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
# Fallback toolchain in case a native module (better-sqlite3, argon2) has no prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    DOCS_DIR=/app/docs \
    WEB_DIR=/app/dist-web \
    PORT=8787
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/package.json ./
COPY docs ./docs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Caps the heap so the monthly barcode import (streaming ~10 GB of text) GCs instead of growing RSS.
CMD ["node", "--max-old-space-size=512", "server/dist/index.js"]
