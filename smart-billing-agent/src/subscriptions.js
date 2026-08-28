'use strict';

// ============================================================================
// Renovação mensal de assinaturas (planos recurring_monthly).
// ----------------------------------------------------------------------------
// A InfinitePay não tem, nesta integração, cobrança recorrente automática
// confirmada (ver docs/PLANOS_E_ASSINATURAS.md) — o Smart Billing controla a
// recorrência mensal sozinho: a cada ciclo do scheduler, lista assinaturas
// com next_billing_at vencido e pede para a Edge Function gerar a cobrança
// do próximo mês + checkout + aviso de WhatsApp, uma por vez.
//
// Idempotência: create_subscription_renewal_charge é uma RPC do banco
// idempotente por (subscription_id, renewal_period) — rodar este ciclo de
// novo (ou em paralelo, ex.: dois processos do worker por engano) nunca gera
// duas cobranças para o mesmo mês da mesma assinatura. Nada em memória deste
// módulo protege contra duplicidade — a proteção real é sempre no banco.
//
// Um erro em UMA assinatura nunca interrompe as demais (try/catch por item),
// mesmo padrão já usado em billing.js.
// ============================================================================

const logger = require('./logger');
const agentApi = require('./agentApi');

async function processRenewal(renewal) {
  const result = { subscriptionId: renewal.subscription_id, status: null };
  try {
    const res = await agentApi.createSubscriptionRenewalCharge(renewal.subscription_id);
    if (res?.success) {
      result.status = 'created';
      logger.info(`[RENEWAL] Cobrança de renovação gerada para ${renewal.client_name} (plano ${renewal.plan_name})${res.checkout_url ? ' com checkout' : ' sem checkout (verifique a integração InfinitePay)'}.`);
    } else {
      result.status = `failed: ${res?.message || 'erro desconhecido'}`;
      logger.warn(`[RENEWAL] Falha ao renovar assinatura de ${renewal.client_name}: ${res?.message}`);
    }
  } catch (err) {
    result.status = `error: ${err.message}`;
    logger.error(`[RENEWAL] Erro inesperado ao renovar assinatura de ${renewal.client_name}:`, err.message);
  }
  return result;
}

async function runRenewalCycle() {
  const listResult = await agentApi.listDueSubscriptionRenewals();
  if (!listResult?.success) {
    logger.warn('[RENEWAL] Não foi possível consultar assinaturas a renovar:', listResult?.message || '(sem detalhes)');
    return { subscriptionsAnalyzed: 0, renewed: 0, errors: 1 };
  }

  const renewals = listResult.renewals || [];
  if (renewals.length === 0) {
    return { subscriptionsAnalyzed: 0, renewed: 0, errors: 0 };
  }
  logger.info(`[RENEWAL] ${renewals.length} assinatura(s) com renovação mensal vencida.`);

  let renewed = 0;
  let errors = 0;
  for (const renewal of renewals) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processRenewal(renewal);
    if (result.status === 'created') renewed += 1;
    else errors += 1;
  }

  return { subscriptionsAnalyzed: renewals.length, renewed, errors };
}

module.exports = { runRenewalCycle };
