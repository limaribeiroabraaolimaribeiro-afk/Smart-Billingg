// ============================================================================
// create-checkout-for-token
// ----------------------------------------------------------------------------
// Chamada pela página pública cobranca-publica.html (sem login) quando o
// cliente clica em "Pagar agora" numa cobrança VENCIDA. Recebe SOMENTE o
// public_token — nunca um valor. Equivalente público de
// create-infinitepay-checkout (que exige sessão de admin), usado só quando é
// o próprio cliente final, sem login, quem precisa de um checkout com o
// valor atualizado (multa + juros) travado no servidor.
//
// Para cobranças em dia, o frontend continua usando o checkout_url já
// carregado (não precisa chamar esta function) — ela só existe pra resolver
// o caso "cobrança venceu, o link antigo tem o valor errado".
//
// Toda a decisão de reaproveitar vs. gerar checkout novo, e todo o cálculo
// de multa/juros, vive em resolveChargeCheckoutUrl / lock_late_charge_amount
// (banco) — ver _shared/infinitepay.ts e sql/late_fees_and_interest.sql.
//
// Secrets exigidos (os mesmos já usados por create-infinitepay-checkout):
//   INFINITEPAY_HANDLE, PUBLIC_APP_URL
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  handleOptions,
  jsonResponse,
  logEvent,
  isValidUuid,
  resolveChargeCheckoutUrl,
} from '../_shared/infinitepay.ts';

const FN_NAME = 'create-checkout-for-token';

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

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: 'Corpo da requisição inválido.' }, 400);
  }

  const token = body?.token;
  if (!isValidUuid(token)) {
    return jsonResponse({ success: false, message: 'token inválido.' }, 400);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: charge, error: chargeErr } = await adminClient
    .from('charges')
    .select('id, company_id, client_id, charge_number, description, amount, due_date, status, public_token, checkout_url')
    .eq('public_token', token)
    .maybeSingle();

  if (chargeErr || !charge) {
    return jsonResponse({ success: false, message: 'Cobrança não encontrada.' }, 404);
  }

  if (charge.status === 'paid' || charge.status === 'cancelled') {
    return jsonResponse({ success: false, message: 'Cobrança paga ou cancelada não pode gerar checkout.' }, 400);
  }

  if (!(Number(charge.amount) > 0)) {
    return jsonResponse({ success: false, message: 'Valor da cobrança inválido.' }, 400);
  }

  const redirectUrl = `${PUBLIC_APP_URL}/pagamento-confirmado.html?token=${charge.public_token}`;
  const webhookUrl = `${SUPABASE_URL}/functions/v1/infinitepay-webhook`;

  const result = await resolveChargeCheckoutUrl(adminClient, charge, {
    handle: INFINITEPAY_HANDLE,
    redirectUrl,
    webhookUrl,
  });

  if (!result.ok || !result.checkoutUrl) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'resolve_checkout_failed', message: result.message });
    return jsonResponse({ success: false, message: result.message || 'Não foi possível gerar o checkout.' }, 502);
  }

  logEvent(FN_NAME, { charge_number: charge.charge_number, status: 'resolved' });
  return jsonResponse({ success: true, checkout_url: result.checkoutUrl });
});
