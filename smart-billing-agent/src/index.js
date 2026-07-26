'use strict';

// ============================================================================
// Smart Billing Agent — ponto de entrada.
// ----------------------------------------------------------------------------
// Sobe o servidor local (diagnóstico + controle), inicia o WhatsApp
// automaticamente e começa a consultar a fila de mensagens. Ver README.md
// para instruções de instalação e uso.
// ============================================================================

const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsappService');
const agentApi = require('./agentApi');
const queue = require('./queue');
const { createServer } = require('./server');

let lastReportedStatus = null;

whatsapp.on('status', (status, extra) => {
  if (status === lastReportedStatus && status !== 'error') return;
  lastReportedStatus = status;
  logger.info(`[whatsapp] status: ${status}${extra?.errorMessage ? ` (${extra.errorMessage})` : ''}`);
  agentApi.updateStatus(status, extra?.errorMessage ? { error_message: extra.errorMessage } : {});
});

whatsapp.on('qr', (qrDataUrl) => {
  logger.info('[whatsapp] Novo QR Code gerado — escaneie no WhatsApp do celular.');
  agentApi.updateQr(qrDataUrl);
});

whatsapp.on('ready', ({ phoneNumber, displayName }) => {
  logger.info(`[whatsapp] Conectado como "${displayName || 'desconhecido'}" (${phoneNumber || '—'}).`);
  agentApi.updateStatus('ready', { phone_number: phoneNumber, display_name: displayName });
});

whatsapp.on('auth_failure', (msg) => {
  logger.error('[whatsapp] Falha de autenticação:', msg);
});

// Reconexão automática: se a desconexão não foi um logout deliberado
// (whatsapp.logout() já deixa o status em "offline"), tenta reconectar
// sozinho depois de um pequeno atraso.
whatsapp.on('disconnected', (reason) => {
  logger.warn('[whatsapp] Desconectado:', reason);
  setTimeout(() => {
    if (whatsapp.status === 'disconnected') {
      whatsapp.start().catch((err) => logger.error('Erro ao tentar reconectar:', err.message));
    }
  }, 5000);
});

function main() {
  logger.info('=== Smart Billing Agent — WhatsApp ===');
  logger.info(`Empresa (COMPANY_ID): ${config.companyId}`);
  logger.info(`Porta local: ${config.port}`);

  const app = createServer();
  app.listen(config.port, '127.0.0.1', () => {
    logger.info(`Servidor local ouvindo em http://127.0.0.1:${config.port}`);
    logger.info(`Página de diagnóstico: http://127.0.0.1:${config.port}/`);
  });

  queue.start();

  // Inicia o WhatsApp automaticamente ao abrir o agente.
  whatsapp.start().catch((err) => logger.error('Erro ao iniciar o WhatsApp:', err.message));
}

process.on('unhandledRejection', (err) => {
  logger.error('Erro não tratado (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
  logger.error('Erro não tratado (uncaughtException):', err);
});

main();
