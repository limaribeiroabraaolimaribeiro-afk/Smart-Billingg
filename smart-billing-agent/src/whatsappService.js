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
const { maskPhoneBR } = require('./phone');

const SESSION_ROOT = path.join(__dirname, '..', '.wwebjs_auth');
const CLIENT_ID = 'smart-billing';

// Alguns contatos foram migrados pelo WhatsApp para identificadores @lid; nesses
// casos o envio para o @c.us "clássico" falha com um destes erros específicos,
// recuperáveis re-resolvendo o numberId.
const LID_ERROR_PATTERNS = [/lid is missing in chat table/i, /no lid for user/i];

function isLidRelatedError(err) {
  const msg = err?.message || '';
  return LID_ERROR_PATTERNS.some((re) => re.test(msg));
}

// numberId pode vir como objeto serializável, como {id: {...}} ou já como
// string, dependendo da versão da lib — nunca forçamos @c.us aqui.
function resolveChatId(numberId) {
  return numberId?._serialized || numberId?.id?._serialized || String(numberId);
}

function idSuffix(chatId) {
  if (typeof chatId === 'string' && chatId.endsWith('@c.us')) return '...@c.us';
  if (typeof chatId === 'string' && chatId.endsWith('@lid')) return '...@lid';
  return '(formato desconhecido)';
}

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

  // Tenta client.sendMessage(chatId, ...) e, se falhar, cai para buscar o
  // chat pelo id resolvido e enviar por ele — cobre casos em que o envio
  // direto não reconhece o identificador @lid.
  async _attemptDelivery(chatId, text) {
    try {
      const sent = await this.client.sendMessage(chatId, text);
      return sent?.id?._serialized || null;
    } catch (primaryErr) {
      try {
        const chat = await this.client.getChatById(chatId);
        const sent = await chat.sendMessage(text);
        return sent?.id?._serialized || null;
      } catch (fallbackErr) {
        throw isLidRelatedError(primaryErr) ? primaryErr : fallbackErr;
      }
    }
  }

  // phoneE164 = "5547999999999" (sem "+"), já normalizado por phone.js.
  async sendMessage(phoneE164, text) {
    if (!this.client || this.status !== 'ready') {
      throw new Error('WhatsApp não conectado');
    }

    const maskedPhone = maskPhoneBR(phoneE164);

    const numberId = await this.client.getNumberId(phoneE164);
    if (!numberId) {
      throw new Error('O número informado não possui WhatsApp.');
    }
    let chatId = resolveChatId(numberId);

    try {
      logger.info(`[whatsapp] Enviando para ${maskedPhone} (id ${idSuffix(chatId)}) — tentativa inicial.`);
      return await this._attemptDelivery(chatId, text);
    } catch (err) {
      if (!isLidRelatedError(err)) {
        logger.error(`[whatsapp] Falha ao enviar para ${maskedPhone} (id ${idSuffix(chatId)}) — tentativa inicial: ${err.message}`);
        throw err;
      }

      // Recuperação: apenas para erros de LID, e apenas uma vez — resolve o
      // numberId de novo e repete o envio com o novo id, sem duplicar.
      logger.warn(`[whatsapp] Erro de LID para ${maskedPhone} (id ${idSuffix(chatId)}) — tentativa inicial: ${err.message}. Tentando recuperar.`);

      const retryNumberId = await this.client.getNumberId(phoneE164);
      if (!retryNumberId) {
        throw new Error('O número informado não possui WhatsApp.');
      }
      chatId = resolveChatId(retryNumberId);

      try {
        logger.info(`[whatsapp] Reenviando para ${maskedPhone} (id ${idSuffix(chatId)}) — retry.`);
        return await this._attemptDelivery(chatId, text);
      } catch (retryErr) {
        logger.error(`[whatsapp] Falha ao enviar para ${maskedPhone} (id ${idSuffix(chatId)}) — retry: ${retryErr.message}`);
        throw retryErr;
      }
    }
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
