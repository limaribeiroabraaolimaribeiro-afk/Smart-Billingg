'use strict';

// ============================================================================
// Fila de mensagens (whatsapp_outbox).
// ----------------------------------------------------------------------------
// A cada POLL_INTERVAL_MS: manda um heartbeat, e — se o WhatsApp estiver
// "ready" — reivindica até 5 mensagens pendentes (claim_jobs, atômico no
// banco via FOR UPDATE SKIP LOCKED) e envia uma a uma, com um pequeno
// intervalo entre elas. Se o computador for desligado no meio do processo,
// as mensagens continuam "pending" (ou voltam a "pending" após falha) e
// serão retomadas quando o agente voltar — não há estado local da fila.
// ============================================================================

const config = require('./config');
const logger = require('./logger');
const agentApi = require('./agentApi');
const whatsapp = require('./whatsappService');
const { normalizePhoneBR, maskPhoneBR } = require('./phone');

const SEND_DELAY_MS = 1500;

let timer = null;
let running = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processJob(job) {
  const normalized = normalizePhoneBR(job.recipient);
  if (!normalized) {
    logger.warn(`[fila] Mensagem ${job.id}: número inválido (${maskPhoneBR(job.recipient)}).`);
    await agentApi.acknowledgeFailed(job.id, 'Número de WhatsApp inválido.');
    return;
  }

  try {
    const whatsappMessageId = await whatsapp.sendMessage(normalized, job.message);
    logger.info(`[fila] Mensagem ${job.id} (${job.message_type}) enviada para ${maskPhoneBR(normalized)}.`);
    await agentApi.acknowledgeSent(job.id, whatsappMessageId);
  } catch (err) {
    logger.error(`[fila] Falha ao enviar mensagem ${job.id} (${maskPhoneBR(normalized)}):`, err.message);
    await agentApi.acknowledgeFailed(job.id, err.message || 'Falha desconhecida ao enviar.');
  }
}

async function tick() {
  if (running) return; // evita sobrepor execuções se um ciclo anterior ainda não terminou
  running = true;
  try {
    await agentApi.heartbeat();

    if (whatsapp.status !== 'ready') {
      return; // sem conexão pronta: só mantém o heartbeat, não reivindica nada
    }

    const result = await agentApi.claimJobs(5);
    const jobs = result?.jobs || [];
    if (jobs.length) {
      logger.info(`[fila] ${jobs.length} mensagem(ns) reivindicada(s).`);
    }
    for (const job of jobs) {
      // eslint-disable-next-line no-await-in-loop
      await processJob(job);
      // eslint-disable-next-line no-await-in-loop
      await sleep(SEND_DELAY_MS);
    }
  } catch (err) {
    logger.error('[fila] Erro inesperado no ciclo da fila:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  logger.info(`[fila] Consultando a cada ${config.pollIntervalMs}ms.`);
  timer = setInterval(tick, config.pollIntervalMs);
  tick();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop };
