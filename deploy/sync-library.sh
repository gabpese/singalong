#!/usr/bin/env bash
# Copia a biblioteca de músicas já processadas do seu PC para a VM (rode no Git Bash, na raiz do projeto):
#   deploy/sync-library.sh ubuntu@IP_DA_VM [caminho/da/chave.pem]
#
# Só vai o que a nuvem precisa para TOCAR as músicas: o instrumental, a letra, a melodia, as vozes de apoio, o meta e os
# vídeos MP4 já gerados. Ficam de fora a voz isolada (vocals.mp3) e o source.json, que só o worker usa.
# As músicas são direitos autorais de terceiros: isto vai por SSH para a SUA VM, nunca para o GitHub.
set -euo pipefail

TARGET=${1:?uso: deploy/sync-library.sh usuario@host [chave.pem]}
KEY=${2:-}
SSH=(ssh)
[ -n "$KEY" ] && SSH=(ssh -i "$KEY")

[ -d storage/cache ] || { echo "Rode na raiz do projeto (onde existe storage/cache)."; exit 1; }
count=$(find storage/cache -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "Copiando $count músicas para $TARGET..."

tar -C storage -cf - \
  --exclude='vocals.mp3' --exclude='source.json' --exclude='*.tmp' \
  cache \
  | "${SSH[@]}" "$TARGET" "sudo tar -C /opt/singalong/storage -xf - && sudo chown -R 1000:1000 /opt/singalong/storage"

echo "Pronto. A API enxerga as músicas na hora (não precisa reiniciar)."
