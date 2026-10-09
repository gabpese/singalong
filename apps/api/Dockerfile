# Contexto de build: raiz do repositório (precisa de apps/web/public para servir o player)
FROM node:24-slim

WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev

COPY apps/api/src ./src
COPY apps/web/public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_ROOT=/storage \
    PUBLIC_DIR=/app/public

# pasta do SQLite com o dono certo: um volume novo herda o dono desta pasta
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
