#!/usr/bin/env bash
# Prepara uma VM Ubuntu nova (ex.: Oracle Cloud) para rodar o Singalong. Rode UMA vez, na VM, como o usuário padrão (ubuntu):
#   curl -fsSL https://raw.githubusercontent.com/gabpese/singalong/main/deploy/setup-vm.sh | bash
# É seguro rodar de novo: cada passo confere se já foi feito.
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
# a API roda como o usuário 1000 do container (node) e grava um arquivo de teste na pasta de músicas
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
# As imagens Ubuntu da Oracle vêm com regras de iptables que bloqueiam tudo além do SSH. A porta também precisa estar
# liberada na "Security List" da rede, no painel da Oracle (veja o README).
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
