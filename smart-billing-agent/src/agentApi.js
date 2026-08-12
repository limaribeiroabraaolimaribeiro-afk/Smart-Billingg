'use strict';

// ============================================================================
// Cliente HTTP para a Edge Function whatsapp-agent-api.
// ----------------------------------------------------------------------------
// O agente NUNCA fala diretamente com o Postgres/Supabase (nem com a anon
// key): toda leitura/escrita passa por esta function, autenticada pelo
// segredo compartilhado WHATSAPP_AGENT_TOKEN (header x-agent-token). Cada
// chamada é curta e stateless — não há conexão persistente.
// ============================================================================

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

async function call(action, payload = {}) {
  try {
    const { data } = await axios.post(
      config.agentFunctionUrl,
      { action, company_id: config.companyId, ...payload },
      {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'x-agent-token': config.agentToken,
        },
      },
    );
    if (!data?.success) {
      logger.warn(`[agentApi] ${action} retornou success=false:`, data?.message || '(sem mensagem)');
    }
    return data;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    logger.error(`[agentApi] Falha ao chamar "${action}":`, detail);
    return { success: false, message: detail };
  }
}

module.exports = {
  updateStatus: (status, extra = {}) => call('update_status', { status, ...extra }),
  updateQr: (qrCode) => call('update_qr', { qr_code: qrCode }),
  heartbeat: () => call('heartbeat'),
  logoutComplete: () => call('logout_complete'),
  claimJobs: (limit = 5) => call('claim_jobs', { limit }),
  acknowledgeSent: (id, whatsappMessageId) => call('acknowledge_sent', { id, whatsapp_message_id: whatsappMessageId || undefined }),
  acknowledgeFailed: (id, errorMessage) => call('acknowledge_failed', { id, error_message: errorMessage }),

  // ---- Cobrança automática (scheduler) ----
  // Todas passam pela mesma Edge Function whatsapp-agent-api, com o mesmo
  // token compartilhado — o worker nunca guarda a service_role key nem a
  // chave do Resend; ambas ficam só nos secrets do Supabase.
  listReminderCandidates: () => call('list_reminder_candidates'),
  enqueueReminder: ({ chargeId, messageType, message, idempotencyKey }) => call('enqueue_reminder', {
    charge_id: chargeId, message_type: messageType, message, idempotency_key: idempotencyKey,
  }),
  sendEmailReminder: ({ chargeId, kind, idempotencyKey }) => call('send_email_reminder', {
    charge_id: chargeId, kind, idempotency_key: idempotencyKey,
  }),
};
