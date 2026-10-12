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

## Como não gastar nada (leia antes de clicar)

A conta nova da Oracle começa em **Free Trial** (créditos por 30 dias) e **não é atualizada sozinha** para paga: segundo a
[documentação oficial](https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm), o cartão só é cobrado se **você** fizer o *Upgrade*.
Depois do período de teste, o que é **Always Free** continua funcionando; o resto é desativado. Regras:

1. **Nunca clique em "Upgrade"** (o aviso amarelo no topo do painel).
2. **Só crie recursos com o selo "Always Free-eligible"** (a tela de criação mostra). Se não tem o selo, não crie.
3. **VM de no máximo 2 OCPU e 12 GB** (Ampere A1). Acima do limite gratuito, as VMs são **desativadas** e apagadas depois de 30 dias.
4. **Não crie:** NAT Gateway, Load Balancer, volumes extras (o disco da VM e mais os extras somam no máximo 200 GB), banco de dados, nem **IP reservado**.
5. **Orçamento de alerta (recomendado):** *Billing & Cost Management → Budgets → Create budget*, valor US$ 1, alerta em 1%. Ele só **avisa** por e-mail (não bloqueia),
   mas denuncia qualquer cobrança no primeiro centavo.
6. **Entre no painel pelo menos uma vez a cada 60 dias**: contas gratuitas sem uso podem ser desativadas, e VMs ociosas por muito tempo, reclamadas.

## Passo a passo

### 1. Conta e VM na Oracle (você faz; leva ~20 min)
1. Crie a conta em <https://www.oracle.com/cloud/free/>. Pede **cartão** só para verificar a identidade; o Always Free não cobra.
2. Escolha a **região** mais perto de você (ex.: São Paulo ou Vinhedo). Não dá para mudar depois.
3. Em *Compute → Instances → Create instance*:
   - **Imagem:** Canonical **Ubuntu 24.04**.
   - **Forma (shape):** `VM.Standard.A1.Flex` (ARM) com **2 OCPU e 12 GB** (o limite gratuito atual). Se aparecer *Out of capacity*, tente de novo mais tarde ou outra
     zona de disponibilidade; como alternativa, `VM.Standard.E2.1.Micro` (AMD, 1 GB), que também serve para a API.
   - **Chave SSH:** deixe a Oracle gerar e **baixe a chave privada** (`.key`/`.pem`). Guarde bem.
4. Depois de criada, anote o **IP público** (o que a VM recebe sozinha, o "efêmero": é grátis e dura enquanto a VM existir, mesmo ao desligar e ligar).
   **Não reserve um IP** (*Reserved public IPs*): as fontes indicam que o IP reservado pode ser cobrado. Se você recriar a VM, o IP muda e basta atualizar o DuckDNS.
5. Libere as portas: *Networking → Virtual cloud networks → sua VCN → Subnet → Security List → Add Ingress Rules*:
   origem `0.0.0.0/0`, protocolo TCP, portas **80** e **443**.

### 2. Endereço grátis com HTTPS (você faz; 2 min)
O HTTPS é **obrigatório**: sem ele o navegador não libera a troca de tom nem o microfone.
1. Entre em <https://www.duckdns.org> (login com GitHub/Google), crie um subdomínio (`singalong`) e aponte para o **IP público** da VM.
2. Seu endereço será `singalong.duckdns.org`. O Caddy emite o certificado (Let's Encrypt) sozinho.

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

## Pareamento por e-mail (opcional)

Para que cada pessoa peça o código pelo próprio app (em vez de você gerar com o `curl`), o servidor envia o código por e-mail só para quem você autorizar.

1. Crie uma conta gratuita em <https://www.brevo.com> (300 e-mails por dia no plano grátis).
2. Em *Senders, Domains & Dedicated IPs → Senders*, adicione o **e-mail remetente** (pode ser o seu Gmail) e confirme pelo link que o Brevo envia para ele.
3. Em *SMTP & API → API keys*, crie uma chave e copie (ela só aparece uma vez).
4. Na VM, edite o `.env` (`nano /opt/singalong/.env`) e preencha, sem espaços ao redor do `=`:

   ```
   PAIR_ALLOWED_EMAILS=ana@exemplo.com,bia@exemplo.com
   BREVO_API_KEY=a-chave-copiada
   MAIL_FROM=o-email-remetente-verificado@gmail.com
   ```
   Use `PAIR_ALLOWED_EMAILS=*` (um asterisco) para liberar **qualquer** e-mail; continua limitado a poucos pedidos por IP e por endereço.
5. Aplique: `./deploy.sh`. Para autorizar mais gente depois, edite `PAIR_ALLOWED_EMAILS` e rode `./deploy.sh` de novo.

A chave do Brevo é um segredo: fica só no `.env` da VM (nunca no repositório nem no chat). As mensagens podem cair na caixa de spam na primeira vez.

## Modo híbrido: músicas na nuvem (opcional)

Para que as músicas preparadas por certas pessoas passem a existir no servidor (e qualquer sala as toque sem baixar de novo):

1. A pessoa instala o app e pareia **pelo e-mail** (a tela de conectar pede o e-mail e envia o código).
2. Na VM, edite o `.env` (`nano /opt/singalong/.env`) e liste os e-mails que enviam para a nuvem, separados por vírgula:

   ```
   ENABLED_TO_SEND_TO_CLOUD=ana@exemplo.com,bia@exemplo.com
   ```
3. Aplique: `./deploy.sh`. Se o `docker-compose.prod.yml` da VM for antigo, copie o novo deste repositório antes (ele repassa essa variável).

Quem já estava pareado **antes desta versão** precisa parear de novo pelo e-mail (o servidor só passou a guardar o e-mail do pareamento agora); o mesmo vale para quem pareou com um código do administrador sem e-mail. A biblioteca que o computador já tinha sobe sozinha na próxima vez que o app iniciar a sessão. As músicas ficam em `storage/cache` no volume da API; a limpeza automática (`CACHE_MAX_GB`) apaga as menos tocadas quando passa do limite.

## Página do administrador

Em `https://SEU_ENDERECO/admin` (só com o `ADMIN_TOKEN` do `.env`; sem ele a página não existe). Ali você:

- **autoriza e-mails**: quem recebe o código de pareamento e quem envia músicas para a nuvem (muda na hora, sem `deploy.sh`);
- **vê e desconecta os computadores** pareados;
- **remove músicas da nuvem** (elas ficam bloqueadas: nenhum computador as envia de novo até você liberar).

O token é digitado ao abrir e fica só naquela aba do navegador. Não compartilhe o endereço com o token, e use sempre `https`.

## Segurança

- A API não tem login: quem souber o endereço e o código de uma sala entra nela. Não divulgue o endereço.
- Só o Caddy (80/443) fica exposto; a API e o Redis são internos.
- Para fechar mais, dá para colocar o **Cloudflare Access** ou um usuário/senha no Caddy (`basicauth`) na frente. Não vem ligado, porque atrapalha a TV de quem só quer abrir o link.
