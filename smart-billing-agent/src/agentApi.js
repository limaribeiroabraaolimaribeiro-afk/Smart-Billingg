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
  //
  // Nem enqueueDailyReminder nem sendDailyEmailReminder recebem uma
  // idempotency_key daqui — ela é SEMPRE calculada dentro da Edge Function,
  // a partir de company_id+client_id+dia local do SERVIDOR. Isso garante
  // "no máximo 1 lembrete automático por cliente por dia" mesmo que este
  // worker tenha algum bug de fuso horário ou de relógio local.
  listReminderCandidates: () => call('list_reminder_candidates'),
  enqueueDailyReminder: ({ clientId, chargeIds, message }) => call('enqueue_daily_reminder', {
    client_id: clientId, charge_ids: chargeIds, message,
  }),
  sendDailyEmailReminder: ({ clientId, chargeIds }) => call('send_daily_email_reminder', {
    client_id: clientId, charge_ids: chargeIds,
  }),

  // ---- Renovação mensal de assinaturas ----
  // A InfinitePay não confirma cobrança recorrente automática nesta
  // integração — o worker controla o ciclo mensal: lista o que venceu e
  // pede para gerar a cobrança do próximo mês, uma assinatura por vez.
  // create_subscription_renewal_charge é idempotente no banco por
  // (subscription_id, renewal_period) — rodar o ciclo de novo (ou em
  // paralelo) nunca duplica uma renovação.
  listDueSubscriptionRenewals: (limit = 50) => call('list_due_subscription_renewals', { limit }),
  createSubscriptionRenewalCharge: (subscriptionId) => call('create_subscription_renewal_charge', { subscription_id: subscriptionId }),
};
