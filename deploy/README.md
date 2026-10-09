# Hospedagem gratuita (Oracle Cloud) com HTTPS

Objetivo: abrir o Singalong de **qualquer computador** (por exemplo, a TV na casa de um amigo), **sem o seu PC ligado**.

## O que roda na nuvem e o que continua em casa

| | Onde | Por quê |
|---|---|---|
| API, salas, fila, TV, celular, pontuação, vozes de apoio, MP4 já gerados | **VM na nuvem** | É leve e precisa estar sempre no ar. |
| **Músicas novas** (baixar do YouTube, separar voz, alinhar letra) | **seu PC** (worker) | Pesa em CPU e o YouTube bloqueia IPs de datacenter ("Sign in to confirm you're not a bot"). |

Na nuvem você toca a **biblioteca que copiou para lá**. Para ter uma música nova, processe-a em casa e copie de novo (`sync-library.sh`).
Um próximo passo (não feito) seria um armazenamento compartilhado (S3) para o worker de casa abastecer a nuvem sozinho.

> **Direitos autorais.** O repositório é **público**: as músicas (`storage/`) nunca entram nele nem na imagem. Elas vão por SSH direto
> para a **sua** VM. Mantenha o endereço da VM só com quem você quer.

## Passo a passo

### 1. Conta e VM na Oracle (você faz; leva ~20 min)
1. Crie a conta em <https://www.oracle.com/cloud/free/>. Pede **cartão** só para verificar a identidade; o Always Free não cobra.
2. Escolha a **região** mais perto de você (ex.: São Paulo ou Vinhedo). Não dá para mudar depois.
3. Em *Compute → Instances → Create instance*:
   - **Imagem:** Canonical **Ubuntu 24.04**.
   - **Forma (shape):** `VM.Standard.A1.Flex` (ARM) com **2 OCPU e 12 GB** (o limite gratuito atual). Se aparecer *Out of capacity*, tente de novo mais tarde ou outra
     zona de disponibilidade; como alternativa, `VM.Standard.E2.1.Micro` (AMD, 1 GB), que também serve para a API.
   - **Chave SSH:** deixe a Oracle gerar e **baixe a chave privada** (`.key`/`.pem`). Guarde bem.
4. Depois de criada, anote o **IP público**. Em *Networking → Reserved public IPs* reserve um IP e associe à VM, para ele **não mudar**.
5. Libere as portas: *Networking → Virtual cloud networks → sua VCN → Subnet → Security List → Add Ingress Rules*:
   origem `0.0.0.0/0`, protocolo TCP, portas **80** e **443**.

### 2. Endereço grátis com HTTPS (você faz; 2 min)
O HTTPS é **obrigatório**: sem ele o navegador não libera a troca de tom nem o microfone.
1. Entre em <https://www.duckdns.org> (login com GitHub/Google), crie um subdomínio (ex.: `meusingalong`) e aponte para o **IP público** da VM.
2. Seu endereço será `meusingalong.duckdns.org`. O Caddy emite o certificado (Let's Encrypt) sozinho.

### 3. Preparar a VM (1 comando)
No seu PC, no Git Bash (ajuste o caminho da chave e o IP):

```bash
ssh -i ~/Downloads/ssh-key.key ubuntu@IP_DA_VM
# já dentro da VM:
curl -fsSL https://raw.githubusercontent.com/gabpese/singalong/main/deploy/setup-vm.sh | bash
nano /opt/singalong/.env        # troque SITE_ADDRESS pelo seu endereço do DuckDNS
exit                            # saia e entre de novo no SSH (para o grupo docker valer)
```

### 4. Copiar a biblioteca de músicas (do seu PC para a VM)
Na raiz do projeto, no Git Bash:

```bash
deploy/sync-library.sh ubuntu@IP_DA_VM ~/Downloads/ssh-key.key
```

### 5. Publicar a API
A imagem é construída pelo GitHub Actions (aba **Actions → Deploy**, depois que o CI passa na `main`). Primeiro torne o pacote público
(a imagem não tem músicas nem segredos): GitHub → seu perfil → **Packages → singalong-api → Package settings → Change visibility → Public**.

Depois, na VM:

```bash
cd /opt/singalong && ./deploy.sh
```

Abra `https://SEU_ENDERECO.duckdns.org`: crie uma sala e abra a TV.

### 6. Deploy automático a cada merge na `main` (opcional)
No GitHub: **Settings → Secrets and variables → Actions**:
- *Secrets:* `DEPLOY_HOST` (IP da VM), `DEPLOY_USER` (`ubuntu`), `DEPLOY_SSH_KEY` (o **conteúdo** da chave privada, incluindo as linhas `BEGIN/END`).
- *Variables:* `DEPLOY_ENABLED` = `true`.

A partir daí, cada merge na `main` com CI verde publica a imagem e atualiza a VM sozinho.

## Manutenção

- Logs: `cd /opt/singalong && docker compose -f docker-compose.prod.yml logs -f api`
- Reiniciar: `docker compose -f docker-compose.prod.yml restart`
- Atualizar à mão: `./deploy.sh`
- Salas e fila ficam no volume `api-data`; os certificados no `caddy-data` (não apague).
- A Oracle pode reclamar VMs gratuitas **ociosas** por muito tempo; um uso ocasional costuma bastar. Se ela for removida, é só recriar e repetir os passos 3 a 5.

## Segurança

- A API não tem login: quem souber o endereço e o código de uma sala entra nela. Não divulgue o endereço.
- Só o Caddy (80/443) fica exposto; a API e o Redis são internos.
- Para fechar mais, dá para colocar o **Cloudflare Access** ou um usuário/senha no Caddy (`basicauth`) na frente. Não vem ligado, porque atrapalha a TV de quem só quer abrir o link.
