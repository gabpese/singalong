# Build context: the repository's root. The first stage builds the front end (static JS, the same for any architecture) always on the
# machine doing the build; the API serves the result. So the image comes out for amd64 and arm64 without building the front end under emulation.
FROM --platform=$BUILDPLATFORM node:24-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/index.html apps/web/room.html apps/web/tv.html apps/web/stage.html apps/web/vite.config.ts ./
COPY apps/web/public ./public
COPY apps/web/src ./src
RUN npx vite build

# The API compiled with TypeScript 7's tsc (ADR 0017): plain JavaScript, the same for any architecture, built where the build runs.
FROM --platform=$BUILDPLATFORM node:24-slim AS api
WORKDIR /api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
COPY apps/api/tsconfig.json apps/api/tsconfig.admin.json ./
COPY apps/api/scripts ./scripts
COPY apps/api/src ./src
RUN npm run build

FROM node:24-slim

WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=api /api/dist ./dist
COPY --from=web /web/dist ./public

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_ROOT=/storage \
    PUBLIC_DIR=/app/public

# the SQLite folder with the right owner: a new volume inherits this folder's owner
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
