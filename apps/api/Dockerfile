# Contexto de build: raiz do repositório. A primeira etapa constrói o front-end (JS estático, igual para qualquer arquitetura) sempre na
# máquina que está construindo; a API serve o resultado. Assim a imagem sai para amd64 e arm64 sem compilar o front-end sob emulação.
FROM --platform=$BUILDPLATFORM node:24-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/index.html apps/web/room.html apps/web/tv.html apps/web/stage.html apps/web/vite.config.mjs ./
COPY apps/web/public ./public
COPY apps/web/src ./src
RUN npx vite build

# The API compiled with TypeScript 7's tsc (ADR 0017): plain JavaScript, the same for any architecture, built where the build runs.
FROM --platform=$BUILDPLATFORM node:24-slim AS api
WORKDIR /api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
COPY apps/api/tsconfig.json ./
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

# pasta do SQLite com o dono certo: um volume novo herda o dono desta pasta
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
