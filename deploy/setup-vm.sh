#!/usr/bin/env bash
# Prepares a new Ubuntu VM (e.g. Oracle Cloud) to run Singalong. Run it ONCE, on the VM, as the default user (ubuntu):
#   curl -fsSL https://raw.githubusercontent.com/gabpese/singalong/main/deploy/setup-vm.sh | bash
# It is safe to run again: each step checks whether it was already done.
set -euo pipefail

APP_DIR=/opt/singalong
REPO_RAW=https://raw.githubusercontent.com/gabpese/singalong/main/deploy

echo "== 1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

echo "== 2/5 Pastas"
sudo mkdir -p "$APP_DIR/storage/cache"
sudo chown -R "$USER":"$USER" "$APP_DIR"
# the API runs as the container's user 1000 (node) and writes a test file in the songs folder
sudo chown -R 1000:1000 "$APP_DIR/storage"

echo "== 3/5 Memória extra (swap de 2 GB: a VM gratuita pequena tem só 1 GB)"
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== 4/5 Firewall da VM (portas 80 e 443)"
# Oracle's Ubuntu images come with iptables rules that block everything but SSH. The port also has to be
# opened in the network's "Security List", in Oracle's console (see the README).
if command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
      || sudo iptables -I INPUT 6 -p tcp --dport "$port" -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
  sudo netfilter-persistent save >/dev/null 2>&1 || true
fi

echo "== 5/5 Arquivos de produção"
cd "$APP_DIR"
for f in docker-compose.prod.yml Caddyfile deploy.sh; do
  curl -fsSL "$REPO_RAW/$f" -o "$f"
done
chmod +x deploy.sh
[ -f .env ] || curl -fsSL "$REPO_RAW/.env.example" -o .env

echo
echo "Pronto. Faltam: 1) editar $APP_DIR/.env (SITE_ADDRESS), 2) copiar a biblioteca de músicas, 3) rodar ./deploy.sh"
echo "Saia e entre de novo no SSH para o grupo 'docker' valer."
