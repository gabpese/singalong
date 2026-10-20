#!/usr/bin/env bash
# Publica a versão mais recente da API na VM (o GitHub Actions chama este script por SSH depois de cada merge na main;
# você também pode rodar à mão). Roda em /opt/singalong.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Falta o .env (copie de .env.example)."; exit 1; }

# A consistent copy of the SQLite file before the new image starts, made by the running API with its own node:sqlite
# (VACUUM INTO). The last five copies stay in the volume, under /data/backups. No API running (the first deploy): no copy.
if [ -n "$(docker compose -f docker-compose.prod.yml ps -q api 2>/dev/null)" ]; then
  echo "Copying the database..."
  docker compose -f docker-compose.prod.yml --env-file .env exec -T api node --no-warnings - <<'JS' || { echo "The database copy failed: nothing was deployed."; exit 1; }
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, readdirSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const dir = '/data/backups';
mkdirSync(dir, { recursive: true });
const file = join(dir, `singalong-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(process.env.DB_PATH);
db.exec(`VACUUM INTO '${file}'`);
db.close();
const copies = readdirSync(dir).filter((name) => /^singalong-.+\.db$/.test(name)).sort().reverse();
for (const old of copies.slice(5)) unlinkSync(join(dir, old));
console.log(`Copy: ${file}`);
JS
fi

docker compose -f docker-compose.prod.yml --env-file .env pull api
docker compose -f docker-compose.prod.yml --env-file .env up -d --remove-orphans
docker image prune -f >/dev/null

echo "Aguardando a API ficar saudável..."
for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose -f docker-compose.prod.yml ps -q api)" 2>/dev/null || echo "?")
  [ "$status" = "healthy" ] && { echo "API no ar."; docker compose -f docker-compose.prod.yml ps; exit 0; }
  sleep 4
done
echo "A API não ficou saudável a tempo. Veja: docker compose -f docker-compose.prod.yml logs api"
exit 1
