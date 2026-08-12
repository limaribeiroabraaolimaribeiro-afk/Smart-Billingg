'use strict';

// ============================================================================
// Motor de cobrança automática — decide, a cada ciclo do scheduler, quais
// cobranças precisam de lembrete HOJE e dispara WhatsApp/e-mail.
// ----------------------------------------------------------------------------
// Toda a "inteligência" de quais cobranças precisam de lembrete (datas,
// preferências da empresa) já vive no banco/Edge Function
// (list_reminder_candidates, ver supabase/functions/whatsapp-agent-api) —
// este módulo só consome o resultado e decide COMO enviar, sem reimplementar
// nenhuma regra de negócio nova.
//
// Idempotência: cada candidato já vem com whatsapp_idempotency_key/
// email_idempotency_key calculados no servidor a partir de
// "<charge_id>:<kind>" (sem timestamp) — rodar o ciclo várias vezes no
// mesmo dia é seguro, porque o banco (ON CONFLICT / upsert com
// ignoreDuplicates) rejeita a segunda tentativa da mesma chave.
//
// Um erro em UM cliente/cobrança nunca interrompe os demais (try/catch por
// item) — ver ETAPA 13 do pedido original.
// ============================================================================

const logger = require('./logger');
const agentApi = require('./agentApi');
const { reminderMessage } = require('./reminderTemplates');

async function processCandidate(candidate) {
  const { charge, client, kind, message_type: messageType, company_name: companyName,
    whatsapp_idempotency_key: waKey, email_idempotency_key: emailKey } = candidate;

  const result = { chargeId: charge.id, whatsapp: null, email: null };

  // ---- WhatsApp ----
  try {
    const message = reminderMessage(kind, charge, client.name, companyName);
    const res = await agentApi.enqueueReminder({ chargeId: charge.id, messageType, message, idempotencyKey: waKey });
    result.whatsapp = res?.success ? 'enqueued' : `failed: ${res?.message || 'erro desconhecido'}`;
    if (res?.success) {
      logger.info(`[BILLING] WhatsApp (${kind}) enfileirado para cobrança ${charge.charge_number}.`);
    } else {
      logger.warn(`[BILLING] Falha ao enfileirar WhatsApp (${kind}) da cobrança ${charge.charge_number}: ${res?.message}`);
    }
  } catch (err) {
    result.whatsapp = `error: ${err.message}`;
    logger.error(`[BILLING] Erro inesperado ao enfileirar WhatsApp da cobrança ${charge.charge_number}:`, err.message);
  }

  // ---- E-mail (independente do resultado do WhatsApp acima) ----
  if (emailKey && client.has_email) {
    try {
      const res = await agentApi.sendEmailReminder({ chargeId: charge.id, kind, idempotencyKey: emailKey });
      if (res?.skipped) {
        result.email = `skipped: ${res.skipped}`;
      } else if (res?.alreadyProcessed) {
        result.email = 'already_processed';
      } else if (res?.success) {
        result.email = 'sent';
        logger.info(`[EMAIL] Lembrete (${kind}) enviado para cobrança ${charge.charge_number}.`);
      } else {
        result.email = `failed: ${res?.message || 'erro desconhecido'}`;
        logger.warn(`[EMAIL] Falha ao enviar lembrete (${kind}) da cobrança ${charge.charge_number}: ${res?.message}`);
      }
    } catch (err) {
      result.email = `error: ${err.message}`;
      logger.error(`[EMAIL] Erro inesperado ao enviar lembrete da cobrança ${charge.charge_number}:`, err.message);
    }
  } else {
    result.email = 'not_applicable';
  }

  return result;
}

async function runCycle() {
  const listResult = await agentApi.listReminderCandidates();
  if (!listResult?.success) {
    // Supabase temporariamente indisponível ou erro de configuração: registra
    // e encerra o ciclo sem lançar exceção — o próximo ciclo tenta de novo.
    logger.warn('[BILLING] Não foi possível consultar cobranças pendentes de lembrete:', listResult?.message || '(sem detalhes)');
    return { analyzed: 0, whatsappEnqueued: 0, emailSent: 0, errors: 1 };
  }

  const candidates = listResult.candidates || [];
  logger.info(`[BILLING] ${candidates.length} cobrança(s) analisada(s) para lembrete hoje (${listResult.today}).`);

  if (candidates.length === 0) {
    return { analyzed: 0, whatsappEnqueued: 0, emailSent: 0, errors: 0 };
  }

  let whatsappEnqueued = 0;
  let emailSent = 0;
  let errors = 0;

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processCandidate(candidate);
    if (result.whatsapp === 'enqueued') whatsappEnqueued += 1;
    else if (String(result.whatsapp).startsWith('error') || String(result.whatsapp).startsWith('failed')) errors += 1;
    if (result.email === 'sent') emailSent += 1;
    else if (String(result.email).startsWith('error') || String(result.email).startsWith('failed')) errors += 1;
  }

  return { analyzed: candidates.length, whatsappEnqueued, emailSent, errors };
}

module.exports = { runCycle };
