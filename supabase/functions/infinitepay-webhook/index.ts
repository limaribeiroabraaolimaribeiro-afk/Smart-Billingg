// ============================================================================
// infinitepay-webhook
// ----------------------------------------------------------------------------
// Recebe as notificações de pagamento da InfinitePay (servidor a servidor).
// Função pública (verify_jwt = false em supabase/config.toml) — quem chama é
// a InfinitePay, não um usuário logado.
//
// A InfinitePay não fornece assinatura criptográfica de webhook nesta
// integração, então a confirmação obrigatória via POST /payment_check é a
// principal validação de autenticidade antes de gravar qualquer coisa no
// banco — o payload recebido aqui NUNCA é aplicado diretamente sem essa
// confirmação.
//
// Endpoint oficial usado: POST https://api.checkout.infinitepay.io/payment_check
//
// Secrets exigidos (supabase secrets set):
//   INFINITEPAY_HANDLE — InfiniteTag da conta, sem o símbolo "$"
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  handleOptions,
  jsonResponse,
  logEvent,
  reaisToCents,
  mapCaptureMethod,
  callPaymentCheck,
  isValidWebhookPayload,
  readJsonBodyLimited,
  type WebhookPayload,
} from '../_shared/infinitepay.ts';

const FN_NAME = 'infinitepay-webhook';

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Método não permitido.' }, 405);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const INFINITEPAY_HANDLE = (Deno.env.get('INFINITEPAY_HANDLE') ?? '').replace(/^\$/, '').trim();

  if (!INFINITEPAY_HANDLE) {
    logEvent(FN_NAME, { error: 'missing_secrets' });
    return jsonResponse({ success: false, message: 'Integração ainda não configurada.' }, 500);
  }

  let body: unknown;
  try {
    body = await readJsonBodyLimited(req, 20_000);
  } catch {
    return jsonResponse({ success: false, message: 'Corpo da requisição inválido.' }, 400);
  }

  if (!isValidWebhookPayload(body)) {
    logEvent(FN_NAME, { error: 'invalid_payload' });
    return jsonResponse({ success: false, message: 'Payload inválido.' }, 400);
  }
  const payload = body as WebhookPayload;

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ---- 1. Deduplicação em webhook_events (event_id = transaction_nsu) ----
  const { data: existingEvent } = await adminClient
    .from('webhook_events')
    .select('id, processed')
    .eq('provider', 'infinitepay')
    .eq('event_id', payload.transaction_nsu)
    .maybeSingle();

  if (existingEvent?.processed) {
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, status: 'already_processed' });
    return jsonResponse({ success: true, message: 'Evento já processado.' }, 200);
  }

  let eventId: string | null = existingEvent?.id ?? null;
  if (!eventId) {
    const { data: inserted, error: insertErr } = await adminClient
      .from('webhook_events')
      .insert({
        provider: 'infinitepay',
        event_id: payload.transaction_nsu,
        event_type: 'payment.approved',
        payload: payload,
      })
      .select('id')
      .maybeSingle();

    if (insertErr || !inserted) {
      // Corrida concorrente: outra requisição já está processando o mesmo evento.
      logEvent(FN_NAME, { order_nsu: payload.order_nsu, status: 'race_duplicate' });
      return jsonResponse({ success: true, message: 'Evento em processamento.' }, 200);
    }
    eventId = inserted.id;
  }

  async function markError(message: string) {
    await adminClient
      .from('webhook_events')
      .update({ error_message: message })
      .eq('id', eventId);
  }

  // ---- 2. Localizar a cobrança pelo order_nsu ----
  const { data: charge } = await adminClient
    .from('charges')
    .select('id, company_id, amount, status, provider, charge_number')
    .eq('charge_number', payload.order_nsu)
    .maybeSingle();

  if (!charge) {
    await markError('Cobrança não encontrada para order_nsu informado.');
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, error: 'charge_not_found' });
    return jsonResponse({ success: false, message: 'Cobrança não encontrada.' }, 400);
  }

  if (charge.provider !== 'infinitepay') {
    await markError('Cobrança não está associada ao provedor infinitepay.');
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, error: 'provider_mismatch' });
    return jsonResponse({ success: false, message: 'Cobrança inválida para este provedor.' }, 400);
  }

  // ---- 3. Confirmar via payment_check (nunca confiar só no payload recebido) ----
  let check;
  try {
    check = await callPaymentCheck({
      handle: INFINITEPAY_HANDLE,
      order_nsu: payload.order_nsu,
      transaction_nsu: payload.transaction_nsu,
      slug: payload.invoice_slug,
    });
  } catch {
    await markError('Falha de rede ao consultar payment_check.');
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, error: 'payment_check_network_error' });
    return jsonResponse({ success: false, message: 'Não foi possível confirmar o pagamento.' }, 400);
  }

  if (!check.ok || !check.success || !check.paid) {
    await markError('payment_check não confirmou o pagamento (success/paid=false).');
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, status: check.status, error: 'not_confirmed' });
    return jsonResponse({ success: false, message: 'Pagamento não confirmado.' }, 400);
  }

  // ---- 4. Comparar valor confirmado com o valor da cobrança ----
  const confirmedAmountCents = check.amount ?? payload.amount;
  let expectedCents: number;
  try {
    expectedCents = reaisToCents(Number(charge.amount));
  } catch {
    await markError('Valor da cobrança inválido no banco.');
    return jsonResponse({ success: false, message: 'Cobrança com valor inválido.' }, 400);
  }

  if (confirmedAmountCents !== expectedCents) {
    await markError(`Valor divergente: confirmado ${confirmedAmountCents}, esperado ${expectedCents}.`);
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, error: 'amount_mismatch' });
    return jsonResponse({ success: false, message: 'Valor divergente.' }, 400);
  }

  const paymentMethod = mapCaptureMethod(payload.capture_method);
  if (!paymentMethod) {
    await markError('capture_method desconhecido.');
    return jsonResponse({ success: false, message: 'Forma de pagamento não reconhecida.' }, 400);
  }

  // ---- 5. Registrar o pagamento de forma atômica ----
  const { data: registerResult, error: registerErr } = await adminClient.rpc('register_infinitepay_payment', {
    p_charge_id: charge.id,
    p_transaction_nsu: payload.transaction_nsu,
    p_payment_method: paymentMethod,
    p_installments: payload.installments,
    p_amount_cents: confirmedAmountCents,
    p_paid_amount_cents: payload.paid_amount,
    p_receipt_url: payload.receipt_url ?? null,
    p_raw_payload: payload,
  });

  if (registerErr) {
    await markError(`register_infinitepay_payment falhou: ${registerErr.message}`.slice(0, 500));
    logEvent(FN_NAME, { order_nsu: payload.order_nsu, error: 'register_failed' });
    return jsonResponse({ success: false, message: 'Não foi possível registrar o pagamento.' }, 400);
  }

  await adminClient
    .from('webhook_events')
    .update({ processed: true, processed_at: new Date().toISOString(), error_message: null })
    .eq('id', eventId);

  const row = Array.isArray(registerResult) ? registerResult[0] : registerResult;
  logEvent(FN_NAME, { order_nsu: payload.order_nsu, status: 'processed', already_processed: Boolean(row?.already_processed) });
  return jsonResponse({ success: true, message: 'Pagamento processado.' }, 200);
});
