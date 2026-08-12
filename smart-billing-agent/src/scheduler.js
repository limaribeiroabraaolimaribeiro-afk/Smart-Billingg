'use strict';

// ============================================================================
// Scheduler do worker de cobrança automática.
// ----------------------------------------------------------------------------
// Roda billing.runCycle() a cada WORKER_INTERVAL_MINUTES (padrão 30min —
// configurável, nunca um setInterval agressivo de segundos: lembretes são
// por DIA, não por minuto). Mesmo padrão de "single-flight" de queue.js: se
// um ciclo ainda não terminou quando o próximo dispararia, o próximo tick é
// simplesmente pulado, nunca sobreposto.
// ============================================================================

const config = require('./config');
const logger = require('./logger');
const billing = require('./billing');

let timer = null;
let running = false;

async function tick() {
  if (running) {
    logger.warn('[SCHEDULER] Ciclo anterior ainda em execução — pulando este tick.');
    return;
  }
  running = true;
  logger.info('[SCHEDULER] ciclo iniciado');
  try {
    const summary = await billing.runCycle();
    logger.info(`[SCHEDULER] ciclo finalizado — analisadas=${summary.analyzed} whatsapp=${summary.whatsappEnqueued} email=${summary.emailSent} erros=${summary.errors}`);
  } catch (err) {
    // Segurança extra: mesmo que billing.runCycle() já trate seus próprios
    // erros internamente, nunca deixa uma exceção aqui derrubar o processo.
    logger.error('[SCHEDULER] Erro inesperado no ciclo:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  const intervalMs = config.workerIntervalMinutes * 60_000;
  logger.info(`[SCHEDULER] Cobrança automática ativa — ciclo a cada ${config.workerIntervalMinutes} minuto(s).`);
  timer = setInterval(tick, intervalMs);
  tick(); // primeiro ciclo logo na inicialização, sem esperar o primeiro intervalo
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function isRunning() {
  return timer !== null;
}

module.exports = { start, stop, isRunning };
