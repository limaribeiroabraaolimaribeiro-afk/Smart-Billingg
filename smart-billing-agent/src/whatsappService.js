'use strict';

// ============================================================================
// WhatsAppService — wrapper sobre whatsapp-web.js com LocalAuth.
// ----------------------------------------------------------------------------
// Sessão salva em ./.wwebjs_auth/session-smart-billing — totalmente separada
// de qualquer outro agente (ex.: Day Lanches, que usa outro projeto e outra
// pasta). "Desconectar do zero" apaga SOMENTE esta subpasta, nunca a pasta
// .wwebjs_auth inteira nem sessões de outro clientId.
//
// Eventos tratados, conforme whatsapp-web.js: qr, authenticated, ready,
// auth_failure, disconnected, change_state. Não registra listener de
// "message" — esta primeira versão não recebe nem responde mensagens.
// ============================================================================

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('./logger');

const SESSION_ROOT = path.join(__dirname, '..', '.wwebjs_auth');
const CLIENT_ID = 'smart-billing';

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'offline';
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.displayName = null;
    this.errorMessage = null;
    this._starting = false;
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    if ('errorMessage' in extra) this.errorMessage = extra.errorMessage;
    this.emit('status', status, { errorMessage: this.errorMessage });
  }

  async start({ forceNewQR = false } = {}) {
    if (forceNewQR) {
      await this._destroyClient();
      await this._clearSessionFiles();
    } else if (this._starting || this.status === 'ready' || this.status === 'qr_required' || this.status === 'authenticated') {
      return; // já iniciando/rodando — evita instâncias duplicadas do client
    }

    this._starting = true;
    this._setStatus('starting', { errorMessage: null });

    // require tardio: só carrega o Puppeteer quando realmente formos conectar.
    const { Client, LocalAuth } = require('whatsapp-web.js');

    if (!fs.existsSync(SESSION_ROOT)) fs.mkdirSync(SESSION_ROOT, { recursive: true });

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: SESSION_ROOT }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    this.client.on('qr', async (qr) => {
      try {
        qrcodeTerminal.generate(qr, { small: true });
        this.qrDataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
        this._setStatus('qr_required');
        this.emit('qr', this.qrDataUrl);
      } catch (err) {
        logger.error('Erro ao gerar imagem do QR Code:', err.message);
      }
    });

    this.client.on('authenticated', () => {
      this.qrDataUrl = null;
      this._setStatus('authenticated');
      this.emit('authenticated');
    });

    this.client.on('ready', () => {
      this._starting = false;
      this.qrDataUrl = null;
      const info = this.client?.info;
      this.phoneNumber = info?.wid?.user || null;
      this.displayName = info?.pushname || null;
      this._setStatus('ready');
      this.emit('ready', { phoneNumber: this.phoneNumber, displayName: this.displayName });
    });

    this.client.on('auth_failure', (msg) => {
      this._starting = false;
      this._setStatus('error', { errorMessage: `Falha de autenticação: ${msg}` });
      this.emit('auth_failure', msg);
    });

    this.client.on('disconnected', (reason) => {
      this._starting = false;
      this.qrDataUrl = null;
      const wasDeliberateLogout = this.status === 'offline';
      this._setStatus(wasDeliberateLogout ? 'offline' : 'disconnected', { errorMessage: typeof reason === 'string' ? reason : null });
      this.emit('disconnected', reason);
      this.client = null;
    });

    this.client.on('change_state', (state) => {
      this.emit('change_state', state);
    });

    try {
      await this.client.initialize();
    } catch (err) {
      this._starting = false;
      this._setStatus('error', { errorMessage: err.message });
      this.emit('error', err);
    }
  }

  async restart({ forceNewQR = false } = {}) {
    await this._destroyClient();
    if (forceNewQR) await this._clearSessionFiles();
    this._starting = false;
    return this.start({ forceNewQR: false });
  }

  async logout() {
    if (this.client) {
      try { await this.client.logout(); } catch (err) { logger.warn('Erro ao efetuar logout (prosseguindo com a limpeza local):', err.message); }
    }
    await this._destroyClient();
    await this._clearSessionFiles();
    this.phoneNumber = null;
    this.displayName = null;
    this.qrDataUrl = null;
    this.errorMessage = null;
    this._setStatus('offline');
  }

  async _destroyClient() {
    if (!this.client) return;
    try { await this.client.destroy(); } catch (_) { /* ignora — já pode estar encerrado */ }
    this.client = null;
  }

  async _clearSessionFiles() {
    const dir = path.join(SESSION_ROOT, `session-${CLIENT_ID}`);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.error('Erro ao limpar a sessão local:', err.message);
    }
  }

  // phoneE164 = "5547999999999" (sem "+"), já normalizado por phone.js.
  async sendMessage(phoneE164, text) {
    if (!this.client || this.status !== 'ready') {
      throw new Error('WhatsApp não conectado');
    }
    const numberId = await this.client.getNumberId(phoneE164);
    if (!numberId) {
      throw new Error('Este número não possui WhatsApp');
    }
    const sent = await this.client.sendMessage(numberId._serialized, text);
    return sent?.id?._serialized || null;
  }

  getSnapshot() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      phoneNumber: this.phoneNumber,
      displayName: this.displayName,
      errorMessage: this.errorMessage,
    };
  }
}

module.exports = new WhatsAppService();
