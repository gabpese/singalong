# Política de segurança

[English](SECURITY.md) · **Português (Brasil)**

## Versões com suporte

Só a [última release](https://github.com/gabpese/singalong/releases/latest) recebe correções de segurança. O app instalado avisa quando existe uma versão nova; atualize antes de reportar.

## Como reportar uma vulnerabilidade

Reporte em particular, nunca numa issue pública:

1. **Preferido:** o relato privado de vulnerabilidade do GitHub, em [Security → Report a vulnerability](https://github.com/gabpese/singalong/security/advisories/new).
2. **Alternativa:** e-mail para gabrielpese.arq@gmail.com com "Singalong security" no assunto.

Diga o que encontrou, a versão, como reproduzir e o impacto que você espera. O Singalong é mantido por uma pessoa, no tempo livre: conte com uma resposta em até uma semana. Você recebe crédito nas notas da release com a correção, a menos que prefira não aparecer.

## Escopo

Dentro do escopo:

- O servidor da API (`apps/api`): salas, tokens de anfitrião, a API do agente (`/agent/v1`), a página do administrador, a entrega dos arquivos de mídia.
- O app instalável (`apps/desktop`) e o ambiente que ele monta (`apps/engine`), incluindo o servidor local de mídia.
- As páginas web (`apps/web`) e o worker (`apps/worker`).

Fora do escopo:

- Instalações mantidas por outras pessoas (a configuração é delas).
- Questões de direito autoral sobre as músicas processadas; cada usuário responde pelo que baixa ou importa.
- Negação de serviço por puro volume na instância gratuita da nuvem.

## Como o Singalong protege o que importa

- **A sessão do YouTube nunca sai do computador do usuário.** O app instalável mantém o login do YouTube na máquina que baixa; o servidor recebe só um apelido de exibição, nunca cookies, e-mail ou senha.
- **Os agentes só fazem conexões de saída** e aceitam um conjunto fechado de opções de trabalho (o id de um vídeo e as escolhas de letra), nunca comandos arbitrários.
- **Os tokens de aparelho** ficam no arquivo de configuração do app, dentro da pasta de dados do próprio usuário (`config.json`), cifrados pelo cofre do sistema (DPAPI, Keychain ou Secret Service); onde o sistema não oferece cofre, o app avisa que o token está sem proteção. O dono pode revogar um aparelho no servidor a qualquer momento.
- **Segredos ficam fora do repositório:** a pasta `secrets/` é ignorada pelo git, e o servidor lê tokens e chaves de variáveis de ambiente.
- **Os instaladores ainda não têm assinatura digital**; o SmartScreen do Windows e o Gatekeeper do macOS avisam na primeira execução.
