# Contexto de build: raiz do repositório. A primeira etapa constrói o front-end (JS estático, igual para qualquer arquitetura) sempre na
# máquina que está construindo; a API serve o resultado. Assim a imagem sai para amd64 e arm64 sem compilar o front-end sob emulação.
FROM --platform=$BUILDPLATFORM node:24-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/index.html apps/web/room.html apps/web/tv.html apps/web/vite.config.mjs ./
COPY apps/web/public ./public
COPY apps/web/src ./src
RUN npx vite build

FROM node:24-slim

WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev

COPY apps/api/src ./src
COPY --from=web /web/dist ./public

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_ROOT=/storage \
    PUBLIC_DIR=/app/public

# pasta do SQLite com o dono certo: um volume novo herda o dono desta pasta
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
