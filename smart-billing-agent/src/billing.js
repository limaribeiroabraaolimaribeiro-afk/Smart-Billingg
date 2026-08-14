'use strict';

// ============================================================================
// Motor de cobrança automática — decide, a cada ciclo do scheduler, quais
// CLIENTES precisam de lembrete HOJE e dispara UM WhatsApp e UM e-mail
// (no máximo) por cliente, mesmo que ele tenha várias cobranças elegíveis.
// ----------------------------------------------------------------------------
// Toda a "inteligência" de quais cobranças precisam de lembrete (datas,
// preferências da empresa) já vive no banco/Edge Function
// (list_reminder_candidates, ver supabase/functions/whatsapp-agent-api) —
// este módulo só consome o resultado (já agrupado por cliente) e decide
// COMO enviar, sem reimplementar nenhuma regra de negócio nova.
//
// REGRA CRÍTICA (corrigida após bug de produção — cliente recebendo 3
// cobranças no mesmo dia): no máximo 1 mensagem automática de WhatsApp e,
// separadamente, no máximo 1 e-mail automático, por cliente, por dia
// (America/Sao_Paulo). Se o cliente tiver várias cobranças elegíveis, elas
// são consolidadas em UMA única mensagem (ver reminderTemplates.js).
//
// Idempotência: a chave "daily-reminder:<company_id>:<client_id>:<dia>" é
// calculada DENTRO da Edge Function (nunca aqui) e protegida por
// constraint única no banco — rodar o ciclo várias vezes no mesmo dia, ou
// dois ciclos concorrentes, é seguro: a segunda tentativa é rejeitada/
// reaproveitada silenciosamente pelo Postgres, não por lógica em memória
// deste processo.
//
// Um erro em UM cliente nunca interrompe os demais (try/catch por item) —
// ver ETAPA 13 do pedido original.
// ============================================================================

const logger = require('./logger');
const agentApi = require('./agentApi');
const { dailyDigestMessage } = require('./reminderTemplates');

async function processClientCandidate(candidate) {
  const { client, charges, company_name: companyName } = candidate;
  const chargeIds = charges.map((c) => c.id);
  const result = { clientId: client.id, chargeCount: charges.length, whatsapp: null, email: null };

  // ---- WhatsApp (1 mensagem consolidada) ----
  try {
    const message = dailyDigestMessage(charges, client.name, companyName);
    const res = await agentApi.enqueueDailyReminder({ clientId: client.id, chargeIds, message });
    result.whatsapp = res?.success ? 'enqueued' : `failed: ${res?.message || 'erro desconhecido'}`;
    if (res?.success) {
      logger.info(`[BILLING] Resumo diário (${charges.length} cobrança(s)) enfileirado para WhatsApp do cliente ${client.name}.`);
    } else {
      logger.warn(`[BILLING] Falha ao enfileirar resumo diário do cliente ${client.name}: ${res?.message}`);
    }
  } catch (err) {
    result.whatsapp = `error: ${err.message}`;
    logger.error(`[BILLING] Erro inesperado ao enfileirar resumo diário do cliente ${client.name}:`, err.message);
  }

  // ---- E-mail (1 resumo consolidado, independente do resultado do WhatsApp) ----
  if (client.has_email) {
    try {
      const res = await agentApi.sendDailyEmailReminder({ clientId: client.id, chargeIds });
      if (res?.skipped) {
        result.email = `skipped: ${res.skipped}`;
      } else if (res?.alreadyProcessed) {
        result.email = 'already_processed';
      } else if (res?.success) {
        result.email = 'sent';
        logger.info(`[EMAIL] Resumo diário (${charges.length} cobrança(s)) enviado para o cliente ${client.name}.`);
      } else {
        result.email = `failed: ${res?.message || 'erro desconhecido'}`;
        logger.warn(`[EMAIL] Falha ao enviar resumo diário do cliente ${client.name}: ${res?.message}`);
      }
    } catch (err) {
      result.email = `error: ${err.message}`;
      logger.error(`[EMAIL] Erro inesperado ao enviar resumo diário do cliente ${client.name}:`, err.message);
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
    logger.warn('[BILLING] Não foi possível consultar clientes pendentes de lembrete:', listResult?.message || '(sem detalhes)');
    return { clientsAnalyzed: 0, chargesAnalyzed: 0, whatsappEnqueued: 0, emailSent: 0, errors: 1 };
  }

  const candidates = listResult.candidates || [];
  const totalCharges = candidates.reduce((s, c) => s + (c.charges?.length || 0), 0);
  logger.info(`[BILLING] ${candidates.length} cliente(s) / ${totalCharges} cobrança(s) analisada(s) para lembrete hoje (${listResult.today}).`);

  if (candidates.length === 0) {
    return { clientsAnalyzed: 0, chargesAnalyzed: 0, whatsappEnqueued: 0, emailSent: 0, errors: 0 };
  }

  let whatsappEnqueued = 0;
  let emailSent = 0;
  let errors = 0;

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processClientCandidate(candidate);
    if (result.whatsapp === 'enqueued') whatsappEnqueued += 1;
    else if (String(result.whatsapp).startsWith('error') || String(result.whatsapp).startsWith('failed')) errors += 1;
    if (result.email === 'sent') emailSent += 1;
    else if (String(result.email).startsWith('error') || String(result.email).startsWith('failed')) errors += 1;
  }

  return { clientsAnalyzed: candidates.length, chargesAnalyzed: totalCharges, whatsappEnqueued, emailSent, errors };
}

module.exports = { runCycle };
