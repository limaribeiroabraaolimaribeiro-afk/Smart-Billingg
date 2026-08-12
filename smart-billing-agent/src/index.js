'use strict';

// ============================================================================
// Smart Billing Agent/Worker — ponto de entrada.
// ----------------------------------------------------------------------------
// Sobe o servidor local (diagnóstico + controle + /health), inicia o
// WhatsApp automaticamente, começa a consultar a fila de mensagens
// (whatsapp_outbox) e — independente do WhatsApp estar pronto ainda —
// inicia o scheduler de cobrança automática (WhatsApp + e-mail). Ver
// README.md para instruções de instalação e uso, e docs/VPS_SETUP.md para
// rodar isto 24/7 numa VPS.
// ============================================================================

const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsappService');
const agentApi = require('./agentApi');
const queue = require('./queue');
const scheduler = require('./scheduler');
const { createServer } = require('./server');

let lastReportedStatus = null;

// Reconexão automática com backoff exponencial (5s, 10s, 20s, 40s... até um
// teto de 5min). Zera sempre que a conexão fica "ready" de novo. Evita tanto
// desistir para sempre quanto martelar reconexões em loop apertado.
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
let reconnectAttempts = 0;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return; // já existe uma tentativa agendada
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  logger.warn(`[whatsapp] tentando reconectar em ${Math.round(delay / 1000)}s (tentativa ${reconnectAttempts}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (whatsapp.status === 'disconnected') {
      whatsapp.start().catch((err) => logger.error('[whatsapp] Erro ao tentar reconectar:', err.message));
    }
  }, delay);
}

whatsapp.on('status', (status, extra) => {
  if (status === lastReportedStatus && status !== 'error') return;
  lastReportedStatus = status;
  if (status === 'ready') reconnectAttempts = 0; // reconexão bem-sucedida: zera o backoff
  logger.info(`[whatsapp] status: ${status}${extra?.errorMessage ? ` (${extra.errorMessage})` : ''}`);
  agentApi.updateStatus(status, extra?.errorMessage ? { error_message: extra.errorMessage } : {});
});

whatsapp.on('qr', (qrDataUrl) => {
  logger.info('[whatsapp] aguardando QR — novo código gerado, escaneie no WhatsApp do celular.');
  agentApi.updateQr(qrDataUrl);
});

whatsapp.on('authenticated', () => {
  logger.info('[whatsapp] autenticado.');
});

whatsapp.on('ready', ({ phoneNumber, displayName }) => {
  logger.info(`[whatsapp] pronto — conectado como "${displayName || 'desconhecido'}" (${phoneNumber || '—'}).`);
  agentApi.updateStatus('ready', { phone_number: phoneNumber, display_name: displayName });
});

whatsapp.on('auth_failure', (msg) => {
  // Sessão realmente inválida (não é uma queda temporária de rede): não faz
  // sentido tentar reconectar sozinho — precisa de novo QR. Deixa isso claro
  // no log em vez de tentar de novo silenciosamente.
  logger.error(`[whatsapp] falha de autenticação — sessão inválida, será necessário um novo QR Code: ${msg}`);
});

// Reconexão automática: se a desconexão não foi um logout deliberado
// (whatsapp.logout() já deixa o status em "offline"), tenta reconectar
// sozinho com backoff crescente.
whatsapp.on('disconnected', (reason) => {
  logger.warn('[whatsapp] desconectado:', reason || '(motivo não informado)');
  scheduleReconnect();
});

function main() {
  logger.info('=== Smart Billing Worker (WhatsApp + cobrança automática) ===');
  logger.info(`Empresa (COMPANY_ID): ${config.companyId}`);
  logger.info(`Timezone: ${config.timezone}`);
  logger.info(`Porta local: ${config.port}`);

  const app = createServer();
  const httpServer = app.listen(config.port, '127.0.0.1', () => {
    logger.info(`Servidor local ouvindo em http://127.0.0.1:${config.port}`);
    logger.info(`Página de diagnóstico: http://127.0.0.1:${config.port}/`);
  });

  queue.start();
  scheduler.start();

  // Inicia o WhatsApp automaticamente ao abrir o worker.
  whatsapp.start().catch((err) => logger.error('[whatsapp] Erro ao iniciar:', err.message));

  return httpServer;
}

// ----------------------------------------------------------------------------
// Encerramento gracioso (SIGTERM/SIGINT) — importante para o PM2: ao rodar
// "pm2 restart"/"pm2 stop"/reboot da VPS, o processo recebe SIGTERM. Sem
// tratamento, o Puppeteer/Chromium por trás do whatsapp-web.js pode ser
// morto no meio de uma escrita de sessão. Aqui: para o scheduler e a fila
// primeiro (não inicia nada novo), depois fecha a sessão do WhatsApp de
// forma limpa (client.destroy(), NUNCA logout() — isso preservaria a sessão
// mas aqui queremos preservá-la mesmo, então também não chamamos logout()).
// ----------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[WORKER] Sinal ${signal} recebido — encerrando de forma graciosa...`);

  // Válvula de segurança: se o encerramento travar (ex.: Chromium não
  // responde), força a saída depois de 10s em vez de deixar o PM2 precisar
  // enviar SIGKILL (que poderia corromper a sessão salva em disco).
  const forceExitTimer = setTimeout(() => {
    logger.error('[WORKER] Encerramento gracioso demorou demais — forçando saída.');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  scheduler.stop();
  queue.stop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    await whatsapp.shutdown();
    // Aguarda explicitamente (o listener 'status' já dispara isso, mas de
    // forma "fire-and-forget" — sem este await, o processo pode encerrar
    // antes da chamada de rede terminar, deixando o painel com status
    // desatualizado até o próximo heartbeat).
    await agentApi.updateStatus('offline', {});
  } catch (err) {
    logger.error('[WORKER] Erro ao encerrar a sessão do WhatsApp:', err.message);
  }

  logger.info('[WORKER] Encerrado.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  logger.error('Erro não tratado (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
  logger.error('Erro não tratado (uncaughtException):', err);
});

main();
