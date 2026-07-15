// ============================================================================
// check-infinitepay-payment
// ----------------------------------------------------------------------------
// Chamada pela tela pública de retorno do checkout (pagamento-confirmado.js)
// após o cliente ser redirecionado de volta pela InfinitePay. Função pública
// (verify_jwt = false em supabase/config.toml).
//
// Busca a cobrança exclusivamente pelo public_token (nunca por charge_id
// interno) e só confirma o pagamento depois de consultar payment_check —
// nunca marca como pago só por ter recebido parâmetros na URL.
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
  isValidCheckPaymentPayload,
  readJsonBodyLimited,
  type CheckPaymentPayload,
} from '../_shared/infinitepay.ts';

const FN_NAME = 'check-infinitepay-payment';
const GENERIC_NOT_CONFIRMED = { success: true, paid: false } as const;

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
    body = await readJsonBodyLimited(req, 5_000);
  } catch {
    return jsonResponse({ success: false, message: 'Requisição inválida.' }, 400);
  }

  if (!isValidCheckPaymentPayload(body)) {
    return jsonResponse({ success: false, message: 'Requisição inválida.' }, 400);
  }
  const payload = body as CheckPaymentPayload;

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: charge } = await adminClient
    .from('charges')
    .select('id, company_id, amount, status, charge_number, max_installments')
    .eq('public_token', payload.token)
    .maybeSingle();

  if (!charge) {
    return jsonResponse({ success: false, message: 'Cobrança não encontrada.' }, 400);
  }

  if (charge.charge_number !== payload.order_nsu) {
    logEvent(FN_NAME, { error: 'order_nsu_mismatch' });
    return jsonResponse({ success: false, message: 'Requisição inválida.' }, 400);
  }

  // Idempotência: se já está paga, devolve o resultado já registrado sem
  // chamar a InfinitePay de novo nem duplicar nada.
  if (charge.status === 'paid') {
    const paidInfo = await loadPaidPublicInfo(adminClient, charge.id, charge.charge_number, Number(charge.amount));
    if (paidInfo) return jsonResponse(paidInfo, 200);
  }

  if (charge.status === 'cancelled') {
    return jsonResponse(GENERIC_NOT_CONFIRMED, 200);
  }

  let check;
  try {
    check = await callPaymentCheck({
      handle: INFINITEPAY_HANDLE,
      order_nsu: payload.order_nsu,
      transaction_nsu: payload.transaction_nsu,
      slug: payload.slug,
    });
  } catch {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'network_error' });
    return jsonResponse(GENERIC_NOT_CONFIRMED, 200);
  }

  if (!check.ok || !check.success || !check.paid) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, status: check.status, result: 'not_confirmed' });
    return jsonResponse(GENERIC_NOT_CONFIRMED, 200);
  }

  let expectedCents: number;
  try {
    expectedCents = reaisToCents(Number(charge.amount));
  } catch {
    return jsonResponse(GENERIC_NOT_CONFIRMED, 200);
  }

  const confirmedAmountCents = check.amount ?? expectedCents;
  if (confirmedAmountCents !== expectedCents) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'amount_mismatch' });
    return jsonResponse(GENERIC_NOT_CONFIRMED, 200);
  }

  // O endpoint payment_check não documenta capture_method na resposta nesta
  // integração; usamos o valor que a InfinitePay anexou na redirect_url (se
  // o frontend o repassou), com fallback seguro para "pix" quando ausente.
  const paymentMethod = mapCaptureMethod(payload.capture_method) ?? 'pix';

  const { data: registerResult, error: registerErr } = await adminClient.rpc('register_infinitepay_payment', {
    p_charge_id: charge.id,
    p_transaction_nsu: payload.transaction_nsu,
    p_payment_method: paymentMethod,
    p_installments: 1,
    p_amount_cents: confirmedAmountCents,
    p_paid_amount_cents: confirmedAmountCents,
    p_receipt_url: null,
    p_raw_payload: { source: 'check-infinitepay-payment', order_nsu: payload.order_nsu, transaction_nsu: payload.transaction_nsu },
  });

  if (registerErr) {
    logEvent(FN_NAME, { charge_number: charge.charge_number, error: 'register_failed' });
    return jsonResponse(GENERIC_NOT_CONFIRMED, 200);
  }

  const row = Array.isArray(registerResult) ? registerResult[0] : registerResult;
  const paidInfo = await loadPaidPublicInfo(adminClient, charge.id, charge.charge_number, Number(charge.amount));
  logEvent(FN_NAME, { charge_number: charge.charge_number, status: 'confirmed', already_processed: Boolean(row?.already_processed) });
  return jsonResponse(paidInfo ?? GENERIC_NOT_CONFIRMED, 200);
});

// Monta a resposta pública (sem IDs internos) a partir do pagamento/recibo já
// registrados para a cobrança.
async function loadPaidPublicInfo(
  adminClient: ReturnType<typeof createClient>,
  chargeId: string,
  chargeNumber: string,
  amountReais: number,
) {
  const { data: payment } = await adminClient
    .from('payments')
    .select('payment_method, installments, gross_amount')
    .eq('charge_id', chargeId)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: receipt } = await adminClient
    .from('receipts')
    .select('public_token')
    .eq('charge_id', chargeId)
    .maybeSingle();

  if (!payment) return null;

  return {
    success: true,
    paid: true,
    charge_number: chargeNumber,
    amount: Number(payment.gross_amount) || amountReais,
    payment_method: payment.payment_method,
    installments: payment.installments,
    receipt_token: receipt?.public_token || null,
  };
}
