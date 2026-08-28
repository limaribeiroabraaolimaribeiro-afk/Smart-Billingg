// ============================================================================
// select-plan-offer
// ----------------------------------------------------------------------------
// Chamada pela página pública oferta.html (sem login) quando o cliente clica
// em "Escolher <plano>". Recebe SOMENTE offer_token e plan_id — nunca preço,
// desconto, duração ou parcelas (essa é a defesa contra adulteração via
// DevTools: o navegador não tem, em nenhum momento, esses valores para
// alterar). Tudo o mais é resolvido no banco por public.select_plan_offer()
// (ver sql/billing_plans.sql, seção 10), que:
//   1. valida a oferta (existe / não expirou / ainda não foi usada);
//   2. valida que o plano pertence à oferta e está ativo;
//   3. reivindica a oferta atomicamente (protege contra clique duplo/duas
//      abas — testado sob concorrência real, ver docs/PLANOS_E_ASSINATURAS.md);
//   4. cria a cobrança REAL em public.charges e a assinatura em status pending.
//
// Esta function só entra em ação DEPOIS que select_plan_offer() confirma que
// uma cobrança nova foi criada: aí ela gera o checkout InfinitePay para essa
// cobrança, reaproveitando EXATAMENTE a mesma lógica/endpoint de
// create-infinitepay-checkout (via _shared/infinitepay.ts) — não existe um
// segundo caminho de integração com a InfinitePay.
//
// Secrets exigidos (os mesmos já usados por create-infinitepay-checkout):
//   INFINITEPAY_HANDLE, PUBLIC_APP_URL
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  handleOptions,
  jsonResponse,
  logEvent,
  reaisToCents,
  normalizePhoneBR,
  isValidInfinitePayCheckoutUrl,
  callCreateLink,
  isValidUuid,
} from '../_shared/infinitepay.ts';

const FN_NAME = 'select-plan-offer';

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Método não permitido.' }, 405);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const INFINITEPAY_HANDLE = (Deno.env.get('INFINITEPAY_HANDLE') ?? '').replace(/^\$/, '').trim();
  const PUBLIC_APP_URL = (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '');

  if (!INFINITEPAY_HANDLE || !PUBLIC_APP_URL) {
    logEvent(FN_NAME, { error: 'missing_secrets' });
    return jsonResponse({ success: false, message: 'Integração ainda não configurada.' }, 500);
  }

  let body: { offer_token?: string; plan_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: 'Corpo da requisição inválido.' }, 400);
  }

  const offerToken = body?.offer_token;
  const planId = body?.plan_id;
  if (!isValidUuid(offerToken) || !isValidUuid(planId)) {
    return jsonResponse({ success: false, message: 'offer_token/plan_id inválidos.' }, 400);
  }

  // service_role: a única forma de chamar select_plan_offer() (restrita a
  // service_role — ver GRANT em sql/billing_plans.sql). O cliente final nunca
  // tem uma sessão/JWT de usuário; a "autenticação" dele é o próprio
  // offer_token secreto e imprevisível.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: selectData, error: selectErr } = await adminClient.rpc('select_plan_offer', {
    p_offer_token: offerToken,
    p_plan_id: planId,
  });

  if (selectErr) {
    logEvent(FN_NAME, { error: 'select_plan_offer_failed', detail: selectErr.message });
    return jsonResponse({ success: false, message: 'Não foi possível processar sua escolha. Tente novamente.' }, 500);
  }

  const row = Array.isArray(selectData) ? selectData[0] : selectData;
  const result = row?.result as string | undefined;

  if (result === 'not_found') {
    return jsonResponse({ success: false, result: 'not_found', message: 'Oferta não encontrada ou cancelada.' }, 404);
  }
  if (result === 'expired') {
    return jsonResponse({ success: false, result: 'expired', message: 'Esta oferta expirou.' }, 410);
  }
  if (result === 'invalid_plan') {
    return jsonResponse({ success: false, result: 'invalid_plan', message: 'Plano inválido para esta oferta.' }, 400);
  }

  const chargeId = row?.charge_id as string | null;
  if (!chargeId) {
    logEvent(FN_NAME, { error: 'unexpected_result', result });
    return jsonResponse({ success: false, message: 'Não foi possível processar sua escolha. Tente novamente.' }, 500);
  }

  // 'created' ou 'already_selected' — em ambos os casos, a cobrança já
  // existe (nova ou de uma seleção anterior/concorrente); segue o mesmo
  // caminho para gerar/reaproveitar o checkout.
  const { data: charge, error: chargeErr } = await adminClient
    .from('charges')
    .select('id, company_id, client_id, charge_number, description, amount, status, public_token, checkout_url')
    .eq('id', chargeId)
    .maybeSingle();

  if (chargeErr || !charge) {
    logEvent(FN_NAME, { error: 'charge_not_found_after_select' });
    return jsonResponse({ success: false, message: 'Não foi possível localizar a cobrança gerada.' }, 500);
  }

  // Reaproveita checkout já existente (mesma regra de create-infinitepay-checkout).
  if (isValidInfinitePayCheckoutUrl(charge.checkout_url)) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, status: 'reused_existing', result });
    return jsonResponse({ success: true, result, checkout_url: charge.checkout_url, charge_public_token: charge.public_token });
  }

  if (charge.status === 'paid' || charge.status === 'cancelled') {
    // Já foi paga/cancelada entre a seleção e agora (ex.: clique duplo bem
    // espaçado no tempo) — não faz sentido gerar checkout novo.
    return jsonResponse({ success: true, result, checkout_url: null, charge_public_token: charge.public_token });
  }

  let client: { name?: string; email?: string; whatsapp?: string } | null = null;
  if (charge.client_id) {
    const { data: clientRow } = await adminClient
      .from('clients')
      .select('name, email, whatsapp')
      .eq('id', charge.client_id)
      .maybeSingle();
    client = clientRow;
  }

  let amountCents: number;
  try {
    amountCents = reaisToCents(Number(charge.amount));
  } catch {
    logEvent(FN_NAME, { error: 'invalid_amount', charge_number: charge.charge_number });
    return jsonResponse({ success: false, message: 'Valor inválido para checkout.' }, 500);
  }

  const redirectUrl = `${PUBLIC_APP_URL}/pagamento-confirmado.html?token=${charge.public_token}`;
  const webhookUrl = `${SUPABASE_URL}/functions/v1/infinitepay-webhook`;

  const customer: Record<string, string> = {};
  if (client?.name) customer.name = client.name;
  if (client?.email) customer.email = client.email;
  const phone = normalizePhoneBR(client?.whatsapp);
  if (phone) customer.phone_number = phone;

  const linkPayload = {
    handle: INFINITEPAY_HANDLE,
    redirect_url: redirectUrl,
    webhook_url: webhookUrl,
    order_nsu: charge.charge_number,
    ...(Object.keys(customer).length ? { customer } : {}),
    items: [
      {
        quantity: 1,
        price: amountCents,
        description: charge.description,
      },
    ],
  };

  let result2;
  try {
    result2 = await callCreateLink(linkPayload);
  } catch {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'network_error' });
    return jsonResponse({ success: false, message: 'Não foi possível conectar à InfinitePay.' }, 502);
  }

  if (!result2.ok || !isValidInfinitePayCheckoutUrl(result2.url)) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, status: result2.status, error: 'invalid_response' });
    return jsonResponse({ success: false, message: 'A InfinitePay não retornou um checkout válido.' }, 502);
  }

  const { error: updateErr } = await adminClient
    .from('charges')
    .update({ provider: 'infinitepay', provider_reference: charge.charge_number, checkout_url: result2.url })
    .eq('id', charge.id);

  if (updateErr) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'db_update_failed' });
    return jsonResponse({ success: false, message: 'Checkout criado, mas não foi possível salvar. Tente novamente.' }, 500);
  }

  logEvent(FN_NAME, { charge_number: charge.charge_number, status: 'created', result });
  return jsonResponse({ success: true, result, checkout_url: result2.url, charge_public_token: charge.public_token });
});
