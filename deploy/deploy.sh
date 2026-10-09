#!/usr/bin/env bash
# Publica a versão mais recente da API na VM (o GitHub Actions chama este script por SSH depois de cada merge na main;
# você também pode rodar à mão). Roda em /opt/singalong.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Falta o .env (copie de .env.example)."; exit 1; }

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
