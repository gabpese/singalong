#!/usr/bin/env bash
# Copies the library of songs already prepared from your PC to the VM (run it in Git Bash, at the project's root):
#   deploy/sync-library.sh ubuntu@VM_IP [path/to/key.pem]
#
# Only what the cloud needs to PLAY the songs goes: the instrumental, the lyrics, the melody, the backing vocals, the meta and the
# MP4 videos already made. The isolated voice (vocals.mp3) and source.json, which only the worker uses, stay behind.
# The songs are third parties' copyright: this goes by SSH to YOUR VM, never to GitHub.
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
