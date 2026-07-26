'use strict';

// ============================================================================
// Servidor local de diagnóstico/controle — http://127.0.0.1:PORT
// ----------------------------------------------------------------------------
// Rotas: GET /health, GET /status, POST /start, POST /logout, POST /restart,
// POST /send-test. CORS liberado somente para localhost/127.0.0.1 (a própria
// página de diagnóstico) e para a URL pública do Smart Billing (o painel
// principal, quando aberto NO MESMO computador que este agente).
// ============================================================================

const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsappService');
const agentApi = require('./agentApi');
const { normalizePhoneBR } = require('./phone');
const pkg = require('../package.json');

const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

let allowedPublicHost = null;
try {
  if (config.publicAppUrl) allowedPublicHost = new URL(config.publicAppUrl).host;
} catch (_) {
  logger.warn('PUBLIC_APP_URL inválida no .env — ignorando para fins de CORS.');
}

function corsOriginCheck(origin, callback) {
  // Sem header Origin (curl, chamadas same-origin da própria página local): permite.
  if (!origin) return callback(null, true);
  try {
    const { hostname, host } = new URL(origin);
    if (ALLOWED_LOCAL_HOSTS.has(hostname) || (allowedPublicHost && host === allowedPublicHost)) {
      return callback(null, true);
    }
  } catch (_) { /* origin malformado — cai no bloqueio abaixo */ }
  callback(new Error('Origem não permitida por CORS'));
}

function createServer() {
  const app = express();
  app.use(cors({ origin: corsOriginCheck }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => {
    res.json({ ok: true, name: pkg.name, version: pkg.version });
  });

  app.get('/status', (req, res) => {
    res.json({ ok: true, ...whatsapp.getSnapshot() });
  });

  app.post('/start', (req, res) => {
    whatsapp.start().catch((err) => logger.error('Erro ao iniciar o WhatsApp:', err.message));
    res.json({ ok: true, message: 'Início solicitado.' });
  });

  app.post('/restart', (req, res) => {
    const forceNewQR = Boolean(req.body?.forceNewQR);
    whatsapp.restart({ forceNewQR }).catch((err) => logger.error('Erro ao reiniciar o WhatsApp:', err.message));
    res.json({ ok: true, message: forceNewQR ? 'Gerando novo QR Code...' : 'Reconectando...' });
  });

  // "Desconectar do zero": encerra a sessão do WhatsApp, apaga SOMENTE a
  // sessão do Smart Billing em .wwebjs_auth (nunca a de outro agente) e avisa
  // o Supabase (logout_complete) para o painel refletir "offline" na hora.
  app.post('/logout', async (req, res) => {
    try {
      await whatsapp.logout();
      await agentApi.logoutComplete();
      res.json({ ok: true, message: 'Sessão encerrada.' });
    } catch (err) {
      logger.error('Erro ao desconectar:', err.message);
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // Uso da página de diagnóstico local (public/index.html) — envia direto,
  // sem passar pela fila do Supabase. O painel principal do Smart Billing usa
  // a fila (whatsapp_outbox) para o botão "Enviar mensagem de teste".
  app.post('/send-test', async (req, res) => {
    const normalized = normalizePhoneBR(req.body?.to);
    if (!normalized) {
      return res.status(400).json({ ok: false, message: 'Informe um número de WhatsApp válido em "to".' });
    }
    try {
      const whatsappMessageId = await whatsapp.sendMessage(
        normalized,
        'Mensagem de teste do agente local do Smart Billing ✅',
      );
      res.json({ ok: true, whatsappMessageId });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  return app;
}

module.exports = { createServer };
