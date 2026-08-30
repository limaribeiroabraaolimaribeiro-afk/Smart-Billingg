// ============================================================================
// _shared/infinitepay.ts — helpers reaproveitados pelas 3 Edge Functions da
// integração com o Checkout Integrado da InfinitePay.
// ----------------------------------------------------------------------------
// Contém apenas os dois endpoints oficiais documentados:
//   POST https://api.checkout.infinitepay.io/links
//   POST https://api.checkout.infinitepay.io/payment_check
// Nenhuma outra rota ou credencial é inventada aqui.
// ============================================================================

export const INFINITEPAY_LINKS_URL = 'https://api.checkout.infinitepay.io/links';
export const INFINITEPAY_PAYMENT_CHECK_URL = 'https://api.checkout.infinitepay.io/payment_check';

// Domínios oficiais do checkout hospedado pela InfinitePay. A API de criação
// de link (POST /links) pode responder com qualquer um destes hosts — usado
// para validar a URL retornada antes de salvá-la, e pelo frontend público
// antes de redirecionar o cliente para pagamento.
const INFINITEPAY_CHECKOUT_HOSTS = new Set([
  'checkout.infinitepay.com.br',
  'checkout.infinitepay.io',
]);

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

export function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

// Loga apenas dados operacionais (nome da function, charge_number, status),
// nunca segredos, JWT completo ou dados de cartão.
export function logEvent(fn: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn, ...fields, ts: new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// Conversão de valores — o banco guarda reais (numeric), a API da InfinitePay
// usa centavos (inteiro).
// ---------------------------------------------------------------------------
export function reaisToCents(amountReais: number): number {
  if (!Number.isFinite(amountReais) || amountReais <= 0) {
    throw new Error('Valor inválido para conversão em centavos');
  }
  return Math.round(amountReais * 100);
}

export function centsToReais(amountCents: number): number {
  return Math.round(Number(amountCents)) / 100;
}

// ---------------------------------------------------------------------------
// Telefone — normaliza para o formato internacional +55DDDNNNNNNNNN exigido
// pelo campo customer.phone_number do payload de criação de checkout.
// ---------------------------------------------------------------------------
export function normalizePhoneBR(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  return `+55${digits}`;
}

// ---------------------------------------------------------------------------
// payment_method_type do banco só aceita 'pix' | 'cartao'. A InfinitePay usa
// capture_method 'pix' | 'credit_card'.
// ---------------------------------------------------------------------------
export function mapCaptureMethod(captureMethod: string | null | undefined): 'pix' | 'cartao' | null {
  if (captureMethod === 'pix') return 'pix';
  if (captureMethod === 'credit_card') return 'cartao';
  return null;
}

// ---------------------------------------------------------------------------
// Validação de URL de checkout — exige https, URL bem formada (new URL()) e
// hostname com correspondência EXATA a um dos domínios oficiais da
// InfinitePay (nunca substring/includes — isso aceitaria hosts forjados como
// "checkout.infinitepay.io.site-falso.com").
// ---------------------------------------------------------------------------
export function isValidInfinitePayCheckoutUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && INFINITEPAY_CHECKOUT_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chamadas HTTP aos dois endpoints oficiais.
// ---------------------------------------------------------------------------
export interface CreateLinkPayload {
  handle: string;
  redirect_url: string;
  webhook_url: string;
  order_nsu: string;
  customer?: {
    name?: string;
    email?: string;
    phone_number?: string;
  };
  items: Array<{ quantity: number; price: number; description: string }>;
}

export interface CreateLinkResult {
  ok: boolean;
  status: number;
  url: string | null;
}

export async function callCreateLink(payload: CreateLinkPayload): Promise<CreateLinkResult> {
  const res = await fetch(INFINITEPAY_LINKS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    return { ok: false, status: res.status, url: null };
  }

  let data: { url?: string };
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: res.status, url: null };
  }

  return { ok: true, status: res.status, url: data?.url || null };
}

// ---------------------------------------------------------------------------
// resolveChargeCheckoutUrl — regra ÚNICA de "quando reaproveitar vs. quando
// gerar checkout novo", compartilhada por create-infinitepay-checkout (painel,
// autenticado) e create-checkout-for-token (público). Nunca recebe amount do
// chamador: sempre lê charges.amount/due_date + companies.late_fee_* do banco.
//
// Regra: enquanto a cobrança está dentro do prazo, comportamento idêntico ao
// histórico (reaproveita checkout_url válido, senão cria com `amount`). A
// partir do momento em que due_date passou, o checkout_url antigo NUNCA mais
// é reaproveitado — cada chamada trava o cálculo de multa/juros do dia
// (lock_late_charge_amount, no banco) e gera um link NOVO da InfinitePay com
// `updated_amount`, substituindo o anterior. Isso evita o link antigo (valor
// original) continuar circulando depois que a cobrança venceu.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface ChargeForCheckout {
  id: string;
  company_id: string;
  client_id: string | null;
  charge_number: string;
  description: string;
  amount: number;
  due_date: string;
  status: string;
  checkout_url: string | null;
}

export interface ResolveCheckoutResult {
  ok: boolean;
  checkoutUrl: string | null;
  message?: string;
}

export async function resolveChargeCheckoutUrl(
  adminClient: AdminClient,
  charge: ChargeForCheckout,
  opts: { handle: string; redirectUrl: string; webhookUrl: string },
): Promise<ResolveCheckoutResult> {
  const isOverdue = charge.due_date < new Date().toISOString().slice(0, 10);

  // Dentro do prazo: comportamento idêntico ao de sempre — reaproveita.
  if (!isOverdue && isValidInfinitePayCheckoutUrl(charge.checkout_url)) {
    return { ok: true, checkoutUrl: charge.checkout_url };
  }

  let amountToCharge = Number(charge.amount);

  if (isOverdue) {
    // Trava multa/juros de HOJE no banco antes de gerar o link — nunca a
    // partir de um valor calculado aqui ou recebido do navegador.
    const { data: locked, error: lockErr } = await adminClient.rpc('lock_late_charge_amount', {
      p_charge_id: charge.id,
    });
    if (lockErr || !locked) {
      return { ok: false, checkoutUrl: null, message: 'Não foi possível calcular multa/juros.' };
    }
    const row = Array.isArray(locked) ? locked[0] : locked;
    amountToCharge = Number(row?.updated_amount ?? charge.amount);
  }

  let amountCents: number;
  try {
    amountCents = reaisToCents(amountToCharge);
  } catch {
    return { ok: false, checkoutUrl: null, message: 'Valor da cobrança inválido.' };
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

  const customer: Record<string, string> = {};
  if (client?.name) customer.name = client.name;
  if (client?.email) customer.email = client.email;
  const phone = normalizePhoneBR(client?.whatsapp);
  if (phone) customer.phone_number = phone;

  const linkPayload: CreateLinkPayload = {
    handle: opts.handle,
    redirect_url: opts.redirectUrl,
    webhook_url: opts.webhookUrl,
    order_nsu: charge.charge_number,
    ...(Object.keys(customer).length ? { customer } : {}),
    items: [{ quantity: 1, price: amountCents, description: charge.description }],
  };

  let result: CreateLinkResult;
  try {
    result = await callCreateLink(linkPayload);
  } catch {
    return { ok: false, checkoutUrl: null, message: 'Não foi possível conectar à InfinitePay.' };
  }

  if (!result.ok || !isValidInfinitePayCheckoutUrl(result.url)) {
    return { ok: false, checkoutUrl: null, message: 'A InfinitePay não retornou um checkout válido.' };
  }

  const { error: updateErr } = await adminClient
    .from('charges')
    .update({ provider: 'infinitepay', provider_reference: charge.charge_number, checkout_url: result.url })
    .eq('id', charge.id);

  if (updateErr) {
    return { ok: false, checkoutUrl: null, message: 'Checkout criado, mas não foi possível salvar. Tente novamente.' };
  }

  return { ok: true, checkoutUrl: result.url };
}

export interface PaymentCheckPayload {
  handle: string;
  order_nsu: string;
  transaction_nsu: string;
  slug: string;
}

export interface PaymentCheckResult {
  ok: boolean;
  status: number;
  success: boolean;
  paid: boolean;
  amount: number | null;
}

export async function callPaymentCheck(payload: PaymentCheckPayload): Promise<PaymentCheckResult> {
  const res = await fetch(INFINITEPAY_PAYMENT_CHECK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    return { ok: false, status: res.status, success: false, paid: false, amount: null };
  }

  let data: { success?: boolean; paid?: boolean; amount?: number };
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: res.status, success: false, paid: false, amount: null };
  }

  return {
    ok: true,
    status: res.status,
    success: Boolean(data?.success),
    paid: Boolean(data?.paid),
    amount: typeof data?.amount === 'number' ? data.amount : null,
  };
}

// ---------------------------------------------------------------------------
// Validação básica do payload recebido no webhook — evita confiar cegamente
// no corpo da requisição antes de qualquer processamento.
// ---------------------------------------------------------------------------
export interface WebhookPayload {
  invoice_slug: string;
  amount: number;
  paid_amount: number;
  installments: number;
  capture_method: string;
  transaction_nsu: string;
  order_nsu: string;
  receipt_url?: string;
  items?: unknown[];
}

export function isValidWebhookPayload(body: unknown): body is WebhookPayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.invoice_slug === 'string' && b.invoice_slug.length > 0 &&
    typeof b.order_nsu === 'string' && b.order_nsu.length > 0 &&
    typeof b.transaction_nsu === 'string' && b.transaction_nsu.length > 0 &&
    typeof b.capture_method === 'string' &&
    typeof b.amount === 'number' && b.amount > 0 &&
    typeof b.paid_amount === 'number' &&
    typeof b.installments === 'number' && b.installments >= 1
  );
}

// ---------------------------------------------------------------------------
// Validação básica do payload recebido em check-infinitepay-payment.
// ---------------------------------------------------------------------------
export interface CheckPaymentPayload {
  token: string;
  order_nsu: string;
  transaction_nsu: string;
  slug: string;
  // Opcional: a InfinitePay pode incluir capture_method na redirect_url do
  // retorno do checkout (ver seção "Tela de confirmação"). O endpoint oficial
  // payment_check não documenta esse campo na resposta, então o frontend
  // repassa o valor lido da própria URL de retorno para permitir o
  // mapeamento correto de payment_method (pix/cartão) nesta consulta.
  capture_method?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCheckPaymentPayload(body: unknown): body is CheckPaymentPayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const validBase = (
    typeof b.token === 'string' && UUID_RE.test(b.token) &&
    typeof b.order_nsu === 'string' && b.order_nsu.length > 0 && b.order_nsu.length < 100 &&
    typeof b.transaction_nsu === 'string' && b.transaction_nsu.length > 0 && b.transaction_nsu.length < 200 &&
    typeof b.slug === 'string' && b.slug.length > 0 && b.slug.length < 200
  );
  if (!validBase) return false;
  if (b.capture_method !== undefined && (typeof b.capture_method !== 'string' || b.capture_method.length > 50)) {
    return false;
  }
  return true;
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Lê o corpo como texto limitando o tamanho (proteção básica contra abuso em
// endpoints públicos), e só então faz o parse JSON.
export async function readJsonBodyLimited(req: Request, maxBytes = 10_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new Error('Corpo da requisição excede o tamanho permitido');
  }
  return JSON.parse(text);
}
