// ============================================================================
// create-infinitepay-checkout
// ----------------------------------------------------------------------------
// Chamada pelo painel (autenticado) para gerar o Checkout Integrado da
// InfinitePay de uma cobrança já existente. Todos os dados enviados à
// InfinitePay (valor, descrição, cliente) são lidos diretamente do banco a
// partir do charge_id — nunca aceitos do corpo da requisição — para evitar
// que o valor seja adulterado no DevTools do navegador.
//
// Endpoint oficial usado: POST https://api.checkout.infinitepay.io/links
//
// Secrets exigidos (supabase secrets set):
//   INFINITEPAY_HANDLE   — InfiniteTag da conta, sem o símbolo "$"
//   PUBLIC_APP_URL       — URL pública onde o site estático está hospedado
//
// Variáveis automáticas de toda Edge Function:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
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

const FN_NAME = 'create-infinitepay-checkout';
const MANAGER_ROLES = ['owner', 'admin', 'employee'];

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Método não permitido.' }, 405);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const INFINITEPAY_HANDLE = (Deno.env.get('INFINITEPAY_HANDLE') ?? '').replace(/^\$/, '').trim();
  const PUBLIC_APP_URL = (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '');

  if (!INFINITEPAY_HANDLE || !PUBLIC_APP_URL) {
    logEvent(FN_NAME, { error: 'missing_secrets' });
    return jsonResponse({ success: false, message: 'Integração ainda não configurada.' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) {
    return jsonResponse({ success: false, message: 'Não autenticado.' }, 401);
  }

  let body: { charge_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: 'Corpo da requisição inválido.' }, 400);
  }

  const chargeId = body?.charge_id;
  if (!isValidUuid(chargeId)) {
    return jsonResponse({ success: false, message: 'charge_id inválido.' }, 400);
  }

  // Cliente "comum", com o JWT do usuário, usado apenas para identificar quem
  // está chamando (auth.getUser). Nunca usado para consultas administrativas.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ success: false, message: 'Sessão inválida ou expirada.' }, 401);
  }
  const userId = userData.user.id;

  // Cliente administrativo (service role) — usado para ler/gravar ignorando
  // RLS, já que a autorização já foi verificada manualmente abaixo.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: charge, error: chargeErr } = await adminClient
    .from('charges')
    .select('id, company_id, client_id, charge_number, description, amount, status, public_token, checkout_url, max_installments')
    .eq('id', chargeId)
    .maybeSingle();

  if (chargeErr || !charge) {
    return jsonResponse({ success: false, message: 'Cobrança não encontrada.' }, 404);
  }

  const { data: membership } = await adminClient
    .from('company_members')
    .select('role')
    .eq('company_id', charge.company_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership || !MANAGER_ROLES.includes(membership.role)) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'forbidden' });
    return jsonResponse({ success: false, message: 'Sem permissão para esta cobrança.' }, 403);
  }

  if (charge.status === 'paid' || charge.status === 'cancelled') {
    return jsonResponse({ success: false, message: 'Cobrança paga ou cancelada não pode gerar checkout.' }, 400);
  }

  if (!(Number(charge.amount) > 0)) {
    return jsonResponse({ success: false, message: 'Valor da cobrança inválido.' }, 400);
  }

  // Reaproveita o checkout já existente, evitando gerar links duplicados.
  if (isValidInfinitePayCheckoutUrl(charge.checkout_url)) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, status: 'reused_existing' });
    return jsonResponse({ success: true, checkout_url: charge.checkout_url, charge_number: charge.charge_number });
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
    return jsonResponse({ success: false, message: 'Valor da cobrança inválido.' }, 400);
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

  let result;
  try {
    result = await callCreateLink(linkPayload);
  } catch (err) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'network_error' });
    return jsonResponse({ success: false, message: 'Não foi possível conectar à InfinitePay.' }, 502);
  }

  if (!result.ok || !isValidInfinitePayCheckoutUrl(result.url)) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, status: result.status, error: 'invalid_response' });
    return jsonResponse({ success: false, message: 'A InfinitePay não retornou um checkout válido.' }, 502);
  }

  const { error: updateErr } = await adminClient
    .from('charges')
    .update({
      provider: 'infinitepay',
      provider_reference: charge.charge_number,
      checkout_url: result.url,
    })
    .eq('id', charge.id);

  if (updateErr) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'db_update_failed' });
    return jsonResponse({ success: false, message: 'Checkout criado, mas não foi possível salvar. Tente novamente.' }, 500);
  }

  logEvent(FN_NAME, { charge_number: charge.charge_number, status: 'created' });
  return jsonResponse({ success: true, checkout_url: result.url, charge_number: charge.charge_number });
});
