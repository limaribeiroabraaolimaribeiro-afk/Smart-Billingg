# Smart Billing Agent / Worker — WhatsApp 24/7 + cobrança automática

Agente/worker Node.js que conecta o WhatsApp via QR Code (`whatsapp-web.js` +
`LocalAuth`) para enviar cobranças, lembretes e recibos automaticamente, e
que agora também roda um **scheduler de cobrança automática** (WhatsApp +
e-mail, reaproveitando as preferências já existentes em Configurações →
WhatsApp). O Supabase nunca executa `whatsapp-web.js` diretamente (Edge
Functions não suportam um navegador headless) — por isso este processo
precisa ficar em algum lugar sempre ligado.

Hoje isso pode ser o seu computador (Windows, via `start-agent.bat`, ver
abaixo) ou, futuramente, uma VPS rodando 24/7 com PM2 — ver
[`docs/VPS_SETUP.md`](../docs/VPS_SETUP.md) para o passo a passo de
preparação (Ubuntu 24.04). O código é o mesmo nos dois casos; só muda onde
o processo roda.

Sessão salva em `./.wwebjs_auth/session-smart-billing`, **independente** de
qualquer outra sessão de WhatsApp que você já use em outro projeto (ex.:
Day Lanches, que fica em outra pasta/projeto por completo).

---

## 1. Como instalar

Pré-requisito: [Node.js 22 ou superior](https://nodejs.org).

```bash
cd smart-billing-agent
install-agent.bat
```

O script verifica o Node, roda `npm install` e cria `.env` a partir de
`.env.example` (sem sobrescrever um `.env` já existente).

## 2. Como configurar o `.env`

Abra `smart-billing-agent/.env` e preencha:

| Variável | O que é |
|---|---|
| `SUPABASE_URL` | URL do projeto (Project Settings → API → Project URL) |
| `WHATSAPP_AGENT_FUNCTION_URL` | `https://SEU-PROJETO.supabase.co/functions/v1/whatsapp-agent-api` |
| `WHATSAPP_AGENT_TOKEN` | Segredo compartilhado — veja o passo 3 |
| `COMPANY_ID` | UUID da sua empresa (Supabase → tabela `companies`, coluna `id`) |
| `PUBLIC_APP_URL` | URL pública do Smart Billing (só para logs locais) |
| `POLL_INTERVAL_MS` | Intervalo de consulta à fila (padrão `5000`) |
| `PORT` | Porta do servidor local (padrão `3210`) |

**Nunca** versione o `.env` real — ele já está no `.gitignore`.

## 3. Como criar o `WHATSAPP_AGENT_TOKEN`

É um segredo compartilhado entre este agente e a Edge Function — qualquer
string longa e aleatória serve. Gere uma com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Cole o resultado em **dois lugares**: no `.env` deste agente
(`WHATSAPP_AGENT_TOKEN=...`) e como secret no Supabase (passo 4). Os dois
valores precisam ser **idênticos**.

## 4. Como cadastrar o secret no Supabase

```bash
supabase secrets set WHATSAPP_AGENT_TOKEN=o-mesmo-valor-do-passo-3
```

## 5. Como executar `sql/whatsapp_agent.sql`

No SQL Editor do Supabase (ou via CLI), execute — **nesta ordem**:

1. `sql/supabase_schema.sql` (se ainda não tiver rodado)
2. `sql/whatsapp_agent.sql`

O script é idempotente: pode ser executado de novo sem apagar dados.

## 6. Como publicar `whatsapp-agent-api`

```bash
supabase functions deploy whatsapp-agent-api
```

`supabase/config.toml` já define `verify_jwt = false` para esta function —
ela não recebe sessão de usuário, autentica pelo header `x-agent-token`.

## 7. Como iniciar o agente

```bash
start-agent.bat
```

Mantenha a janela aberta — é ela que mantém o WhatsApp conectado. Se o
processo cair, o script reinicia sozinho depois de alguns segundos.

## 8. Como gerar o QR Code

Ao iniciar pela primeira vez (ou depois de "Desconectar do zero"), o agente
gera um QR Code automaticamente:

- no **terminal** (ASCII, via `qrcode-terminal`);
- no **painel do Smart Billing** (Configurações → WhatsApp), como imagem —
  o agente envia o QR para `whatsapp_agent_state.qr_code` e o painel lê de lá;
- na **página de diagnóstico local** (`http://127.0.0.1:3210`).

## 9. No celular

WhatsApp → **Aparelhos conectados** → **Conectar aparelho** → aponte a
câmera para o QR Code (no painel ou no terminal).

## 10. Como testar uma cobrança

1. Configurações → WhatsApp → confirme que o status está **"WhatsApp
   conectado"**.
2. Cobranças → menu de uma cobrança → **"Enviar cobrança (agente WhatsApp)"**.
3. Confirme o destinatário na caixa de diálogo.
4. O toast mostra **"Mensagem adicionada à fila"** — nunca "enviada" nesse
   momento; o agente confirma o envio real em até `POLL_INTERVAL_MS`.
5. Acompanhe pelo histórico (mesmo menu → "Ver histórico de envio", ou a
   tabela em Configurações → WhatsApp).

## 11. Como verificar a fila

No Supabase (Table Editor ou SQL): tabela `whatsapp_outbox`, coluna
`status` (`pending` → `processing` → `sent`/`failed`). Ou pelo terminal do
agente — cada envio é logado com `[fila] Mensagem ... enviada para ...`.

## 12. Como recuperar uma sessão desconectada

Feche e abra `start-agent.bat` de novo. Se a sessão salva ainda for válida,
o WhatsApp reconecta sozinho, sem novo QR. Se o WhatsApp do celular revogou
o aparelho (ou passou muito tempo offline), o agente pede um novo QR
automaticamente.

## 13. Como gerar um QR novo

Configurações → WhatsApp → **"Gerar novo QR Code"** (funciona com o agente
aberto no mesmo computador), ou na página de diagnóstico local
(`http://127.0.0.1:3210`) → **"Gerar novo QR"**.

## 14. O computador precisa ficar ligado

Sim — enquanto `start-agent.bat` não estiver rodando, nenhuma mensagem é
enviada. Elas ficam `pending` na fila e são enviadas assim que o agente
voltar (nada se perde).

## 15. Iniciar o agente com o Windows (opcional)

Este projeto **não mexe no Windows automaticamente**. Se quiser que
`start-agent.bat` abra sozinho no login:

1. Pressione `Win + R`, digite `shell:startup` e Enter.
2. Crie um atalho para `start-agent.bat` dentro dessa pasta.

(Alternativa avançada: Agendador de Tarefas do Windows, gatilho "ao fazer
logon". Não incluído por padrão para não alterar o sistema sem sua ação.)

## 16. Sessões Day Lanches x Smart Billing

Cada projeto usa **pasta própria**: este agente salva a sessão em
`smart-billing-agent/.wwebjs_auth/session-smart-billing`. O agente do Day
Lanches vive em outro repositório/pasta, com sua própria sessão. "Desconectar
do zero" aqui apaga **apenas** `session-smart-billing` — nunca toca em
sessões de outro projeto.

## 17. Limitações e riscos

- **Integração não oficial**: `whatsapp-web.js` automatiza o WhatsApp Web e
  não é um produto oficial da Meta/WhatsApp. Uso excessivo, envio em massa ou
  padrões suspeitos podem levar ao banimento do número. Este agente não
  implementa disparo em massa nem importação de contatos, e já espaça envios
  consecutivos — mas o risco de bloqueio pela própria Meta nunca é zero.
- **Precisa do computador ligado** e do processo rodando — não é um serviço
  em nuvem.
- **Botões de controle do painel (Conectar/Reconectar/Gerar QR/Desconectar)
  só funcionam no mesmo computador** onde o agente está rodando, porque
  chamam `http://127.0.0.1` diretamente do navegador. Abrindo o painel de
  outro dispositivo, esses botões não alcançam o agente — mas o envio de
  mensagens pela fila continua funcionando normalmente (não depende do
  navegador estar aberto).
- **Lembretes por data (3 dias antes, 1 dia antes, no vencimento, atraso)
  agora têm um scheduler automático** (`src/scheduler.js` + `src/billing.js`),
  além do disparo manual (menu da cobrança → "Enviar lembrete") que
  continua funcionando normalmente. O scheduler reaproveita as MESMAS
  preferências de Configurações → WhatsApp — nenhuma regra nova de data foi
  inventada. **Isso ainda depende de duas coisas que precisam ser aplicadas
  manualmente antes de funcionar em produção:** rodar
  `sql/vps_worker_automation.sql` no Supabase (cria a função de
  enfileiramento do worker e o novo campo `email_reminders_enabled`) e
  publicar a versão atualizada de `whatsapp-agent-api`
  (`supabase functions deploy whatsapp-agent-api`). Até lá, o comportamento
  atual (envio só manual) continua exatamente como está.
- Envio de e-mail nos lembretes é opcional por empresa
  (`email_reminders_enabled`, default desligado) e usa os mesmos secrets do
  Resend já configurados para `send-receipt-email`
  (`RESEND_API_KEY`/`EMAIL_FROM`/`PUBLIC_APP_URL`) — o worker nunca guarda
  essa chave localmente.
- **Não recebe nem responde mensagens** nesta primeira versão — só envia.
- Primeira execução baixa o Chromium via Puppeteer (~200 MB) — precisa de
  internet na primeira vez.
