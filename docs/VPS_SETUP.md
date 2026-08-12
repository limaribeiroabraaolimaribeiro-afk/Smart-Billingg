# Smart Billing — Setup da VPS (Hostinger KVM 2 / Ubuntu 24.04)

> **Este documento é só preparação.** Nada aqui foi executado ainda. Siga
> esta sequência quando a VPS for efetivamente contratada. Nenhum IP, senha
> ou domínio real aparece abaixo — substitua os placeholders
> (`SEU_IP_AQUI`, `seu-usuario`, etc.) pelos valores reais na hora de usar.
>
> **O que a VPS hospeda:** somente o worker de cobrança automática
> (`smart-billing-agent/` — WhatsApp 24/7 + lembretes por WhatsApp/e-mail).
> O frontend continua no GitHub Pages e o banco/Auth continuam no Supabase —
> nada disso muda aqui.

---

## 0. Visão geral da sequência

```
SSH na VPS
   ↓
atualizar Ubuntu
   ↓
criar usuário de aplicação (não usar root no dia a dia)
   ↓
instalar Git
   ↓
instalar Node.js 22 LTS
   ↓
instalar dependências Linux do Chromium (Puppeteer/whatsapp-web.js)
   ↓
clonar o repositório
   ↓
npm install (dentro de smart-billing-agent/)
   ↓
criar .env a partir de .env.example
   ↓
confirmar que a pasta de sessão do WhatsApp é persistente
   ↓
instalar PM2 e iniciar com ecosystem.config.cjs
   ↓
escanear o QR Code (uma única vez)
   ↓
pm2 save + pm2 startup (sobrevive a reboot)
   ↓
configurar firewall (UFW) — só SSH aberto
   ↓
testar reboot da VPS
```

---

## 1. Acessar a VPS via SSH

```bash
ssh root@SEU_IP_AQUI
```

Na primeira conexão, aceite o fingerprint quando solicitado. Troque a senha
de root se a Hostinger tiver enviado uma temporária (`passwd`), ou prefira
configurar autenticação por chave SSH em vez de senha (recomendado, mas fora
do escopo deste documento).

---

## 2. Atualizar o Ubuntu

```bash
sudo apt update
sudo apt upgrade -y
```

Não execute isso ainda — apenas quando a VPS já estiver ativa e você tiver
acesso confirmado.

---

## 3. Criar um usuário de aplicação (não rodar como root)

```bash
adduser smartbilling
usermod -aG sudo smartbilling
```

Depois disso, desconecte e reconecte já como esse usuário:

```bash
ssh smartbilling@SEU_IP_AQUI
```

Todo o restante deste guia assume que você está logado como esse usuário
(não como `root`).

---

## 4. Instalar o Git

```bash
sudo apt install -y git
git --version
```

---

## 5. Instalar o Node.js 22 (LTS)

O projeto declara `"engines": { "node": ">=22" }` em
`smart-billing-agent/package.json`. O Ubuntu 24.04 traz uma versão mais
antiga do Node no repositório padrão — use o repositório oficial da
NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # deve mostrar v22.x
npm --version
```

---

## 6. Instalar as dependências Linux do Chromium (Puppeteer/whatsapp-web.js)

`whatsapp-web.js` usa `puppeteer` (não `puppeteer-core`) — o `npm install`
baixa automaticamente um Chromium compatível (~200 MB, precisa de internet
na primeira vez). Mas o Chromium headless **não roda** num Ubuntu Server
"limpo" sem estas bibliotecas do sistema:

```bash
sudo apt update
sudo apt install -y \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 \
  libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
  libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxss1 libxtst1 lsb-release wget xdg-utils
```

> **Nota sobre nomes de pacote no Ubuntu 24.04:** o Ubuntu 24.04 renomeou
> alguns pacotes de áudio/tempo (ex.: `libasound2` → `libasound2t64`) por
> causa da transição para `time_t` de 64 bits. Se `apt install` reclamar de
> algum nome específico acima como "não encontrado", rode
> `apt-cache search <nome-parcial>` para achar o nome atual no 24.04 — não é
> sinal de erro no restante da lista, só nomenclatura.

Não é necessário instalar um pacote `chromium-browser`/`chromium` separado:
o Puppeteer já baixa e gerencia sua própria cópia do Chromium dentro de
`node_modules`. As bibliotecas acima são só os requisitos de sistema para
esse Chromium conseguir rodar.

---

## 7. Clonar o projeto

```bash
cd ~
git clone https://github.com/limaribeiroabraaolimaribeiro-afk/Smart-Billingg.git
cd Smart-Billingg/smart-billing-agent
```

(Ou o branch/tag específico que você quiser publicar — combine com quem
fizer o deploy.)

---

## 8. Instalar as dependências do Node

```bash
npm install
```

A primeira execução baixa o Chromium do Puppeteer — pode demorar alguns
minutos dependendo da conexão da VPS.

---

## 9. Criar o `.env`

```bash
cp .env.example .env
nano .env
```

Preencha (veja `README.md` do `smart-billing-agent/` para onde encontrar
cada valor):

- `SUPABASE_URL`
- `WHATSAPP_AGENT_FUNCTION_URL`
- `WHATSAPP_AGENT_TOKEN` (o mesmo valor cadastrado como secret no Supabase)
- `COMPANY_ID`
- `PUBLIC_APP_URL`
- `WORKER_INTERVAL_MINUTES` (padrão 30 está bom para a maioria dos casos)
- `TIMEZONE` (deixe `America/Sao_Paulo`)

**Nunca** cole a `SUPABASE_SERVICE_ROLE_KEY` nem a chave do Resend aqui —
o worker não usa nenhuma das duas (ver comentário no próprio
`.env.example`).

---

## 10. Confirmar a pasta persistente de sessão do WhatsApp

Não precisa criar nada manualmente — `src/whatsappService.js` cria
`.wwebjs_auth/` automaticamente na primeira inicialização, dentro de
`smart-billing-agent/`, e é ali (não em `/tmp`) que o `LocalAuth` grava a
sessão. Ela **não está** no `.gitignore` por acaso: nunca deve ir para o
Git, mas deve sobreviver a `pm2 restart`, reboot da VPS e atualização de
código (`git pull`) — só é apagada deliberadamente por "Desconectar do
zero" (painel ou `POST /logout`).

Confirme as permissões depois da primeira inicialização (passo 12):

```bash
ls -la .wwebjs_auth/
```

---

## 11. Instalar o PM2

```bash
sudo npm install -g pm2
pm2 --version
```

---

## 12. Iniciar com PM2

Dentro de `smart-billing-agent/`:

```bash
pm2 start ecosystem.config.cjs
```

---

## 13. Escanear o QR Code

```bash
pm2 logs smart-billing-worker
```

O QR Code em ASCII aparece direto no terminal (via `qrcode-terminal`), do
mesmo jeito que já funciona no uso local pelo Windows. No celular: WhatsApp
→ **Aparelhos conectados** → **Conectar aparelho** → aponte a câmera para o
QR exibido no terminal.

Saia do `pm2 logs` com `Ctrl+C` (isso não para o processo, só o
acompanhamento do log).

---

## 14. Salvar a lista de processos do PM2

```bash
pm2 save
```

---

## 15. Habilitar o PM2 para iniciar sozinho no boot

```bash
pm2 startup
```

O comando acima **imprime uma linha de comando** (algo como
`sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u smartbilling --hp /home/smartbilling`)
— copie exatamente essa linha impressa e rode-a. Depois:

```bash
pm2 save
```

de novo, para garantir que a lista atual (incluindo o
`smart-billing-worker`) seja a que volta sozinha no próximo boot.

---

## 16. Configurar o firewall (UFW)

Veja a seção *Firewall e segurança* abaixo — em resumo, nesta primeira
etapa (sem API HTTP pública), só SSH precisa ficar aberto:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

---

## 17. Testar reboot

```bash
sudo reboot
```

Aguarde a VPS voltar, reconecte via SSH e confirme:

```bash
pm2 status
pm2 logs smart-billing-worker --lines 50
```

O worker deve subir sozinho (PM2 + `pm2 startup`), reconectar ao WhatsApp
usando a sessão salva (sem pedir novo QR) e retomar o scheduler.

---

## Firewall e segurança (UFW)

Nesta primeira versão, o worker **não expõe nenhuma API HTTP pública** — o
servidor Express de `smart-billing-agent/src/server.js` escuta apenas em
`127.0.0.1` (não em `0.0.0.0`), então nem faria diferença abrir a porta no
firewall: ela não é alcançável de fora da própria VPS de qualquer forma.

Recomendação:

```bash
sudo ufw allow OpenSSH   # ou: sudo ufw allow 22/tcp
sudo ufw enable
sudo ufw status verbose
```

Não abra a porta do worker (`PORT` no `.env`, padrão `3210`) publicamente.
Se um dia você quiser acessar `/health` remotamente, faça isso por SSH
tunneling (`ssh -L 3210:127.0.0.1:3210 smartbilling@SEU_IP_AQUI`) ou, se
realmente precisar de acesso HTTP externo, configure Nginx como reverse
proxy com HTTPS e autenticação — isso fica para uma etapa futura, separada,
e não faz parte desta preparação.

---

## Comandos úteis do dia a dia (depois de tudo no ar)

```bash
pm2 status                          # lista processos e status
pm2 logs smart-billing-worker       # acompanha os logs em tempo real
pm2 restart smart-billing-worker    # reinicia (mantém a sessão do WhatsApp)
pm2 stop smart-billing-worker       # para
pm2 start smart-billing-worker      # inicia de novo
```

Para atualizar o código depois de um novo `git push` no repositório:

```bash
cd ~/Smart-Billingg
git pull
cd smart-billing-agent
npm install   # só se package.json mudou
pm2 restart smart-billing-worker
```

---

## Consumo de recursos esperado (KVM 2 — 2 vCPU / 8 GB RAM / 100 GB NVMe)

- **Node.js (worker):** ~50–100 MB de RAM em repouso.
- **Chromium headless (Puppeteer/whatsapp-web.js):** ~200–400 MB em
  repouso, com picos breves (~500–700 MB) durante o envio de mensagens ou
  reconexão.
- **CPU:** praticamente ocioso a maior parte do tempo; picos curtos de CPU
  apenas durante o envio de cada mensagem e durante o handshake de
  reconexão.
- A configuração KVM 2 (8 GB RAM) está **folgada** para esta única carga de
  trabalho — há bastante margem para picos e para rodar outras coisas na
  mesma VPS no futuro, se quiser.
