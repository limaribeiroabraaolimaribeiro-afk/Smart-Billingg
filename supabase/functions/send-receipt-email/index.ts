// ============================================================================
// send-receipt-email
// ----------------------------------------------------------------------------
// Envia por e-mail o recibo de um pagamento confirmado. Todos os dados do
// e-mail (valor, cliente, descrição, cobrança, empresa) são lidos
// diretamente do banco a partir do receipt_id — nunca aceitos do corpo da
// requisição — para impedir que a function seja usada como disparador de
// e-mails arbitrários ou com conteúdo adulterado pelo navegador.
//
// Entrada:  POST { "receipt_id": "<uuid>" }
// Requer:   Authorization: Bearer <jwt do usuário>, membro (owner/admin/
//           employee) da empresa dona do recibo.
//
// Secrets exigidos (supabase secrets set):
//   RESEND_API_KEY   — chave da API do Resend (https://resend.com)
//   EMAIL_FROM       — remetente, ex.: "Smart Billing <recibos@seudominio.com>"
//   PUBLIC_APP_URL   — URL pública onde o site estático está hospedado
//
// Se RESEND_API_KEY/EMAIL_FROM ainda não estiverem configurados, responde
// com { success:false, code:"EMAIL_SERVICE_NOT_CONFIGURED" } — o frontend
// usa esse código para oferecer um fallback de mailto (nunca tratado como
// envio concluído).
//
// Variáveis automáticas de toda Edge Function:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const FN_NAME = 'send-receipt-email';
const MANAGER_ROLES = ['owner', 'admin', 'employee'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Loga apenas dados operacionais (nome da function, receipt_number, status),
// nunca segredos, JWT completo ou conteúdo do e-mail.
function logEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: FN_NAME, ...fields, ts: new Date().toISOString() }));
}

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

function paymentMethodLabel(method: string | null | undefined, installments: number | null | undefined): string {
  if (method === 'pix') return 'Pix';
  if (method === 'cartao') return (installments || 1) > 1 ? `Cartão · ${installments}x` : 'Cartão · à vista';
  return method || '—';
}

function formatCurrencyBRL(value: number): string {
  return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTimeBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const timePart = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  return `${datePart} às ${timePart}`;
}

function escapeHtml(str: string): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Método não permitido.' }, 405);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
  const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? '';
  const PUBLIC_APP_URL = (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '');

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) {
    return jsonResponse({ success: false, message: 'Não autenticado.' }, 401);
  }

  let body: { receipt_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: 'Corpo da requisição inválido.' }, 400);
  }

  const receiptId = body?.receipt_id;
  if (!isValidUuid(receiptId)) {
    return jsonResponse({ success: false, message: 'receipt_id inválido.' }, 400);
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

  const { data: receipt, error: receiptErr } = await adminClient
    .from('receipts')
    .select(`
      id, company_id, charge_id, receipt_number, issued_at, public_token,
      charge:charges(charge_number, description, client:clients(name, email)),
      payment:payments(gross_amount, payment_method, installments, paid_at)
    `)
    .eq('id', receiptId)
    .maybeSingle();

  if (receiptErr || !receipt) {
    return jsonResponse({ success: false, message: 'Recibo não encontrado.' }, 404);
  }

  const { data: membership } = await adminClient
    .from('company_members')
    .select('role')
    .eq('company_id', receipt.company_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership || !MANAGER_ROLES.includes(membership.role)) {
    logEvent({ receipt_number: receipt.receipt_number, error: 'forbidden' });
    return jsonResponse({ success: false, message: 'Sem permissão para este recibo.' }, 403);
  }

  const charge = receipt.charge as { charge_number?: string; description?: string; client?: { name?: string; email?: string } } | null;
  const client = charge?.client ?? null;
  const payment = receipt.payment as { gross_amount?: number; payment_method?: string; installments?: number; paid_at?: string } | null;

  const recipientEmail = client?.email;
  if (!isValidEmail(recipientEmail)) {
    return jsonResponse({ success: false, message: 'Cliente não possui e-mail válido cadastrado.' }, 400);
  }

  if (!PUBLIC_APP_URL) {
    logEvent({ receipt_number: receipt.receipt_number, error: 'missing_public_app_url' });
    return jsonResponse({ success: false, message: 'Integração ainda não configurada.' }, 500);
  }

  const publicLink = `${PUBLIC_APP_URL}/recibo-publico.html?token=${receipt.public_token}`;

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    logEvent({ receipt_number: receipt.receipt_number, error: 'email_service_not_configured' });
    return jsonResponse({
      success: false,
      code: 'EMAIL_SERVICE_NOT_CONFIGURED',
      message: 'O envio automático de e-mail ainda não foi configurado.',
    }, 503);
  }

  const { data: company } = await adminClient
    .from('companies')
    .select('name')
    .eq('id', receipt.company_id)
    .maybeSingle();

  const clientName = client?.name || 'Cliente';
  const companyName = company?.name || 'Smart Billing';
  const valorFormatado = formatCurrencyBRL(Number(payment?.gross_amount || 0));
  const formaPagamento = paymentMethodLabel(payment?.payment_method, payment?.installments);
  const dataPagamento = formatDateTimeBR(payment?.paid_at);
  const chargeNumber = charge?.charge_number || '—';
  const description = charge?.description || '';

  const subject = `Recibo ${receipt.receipt_number} — ${companyName}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
      <h2 style="margin-bottom:4px;">${escapeHtml(companyName)}</h2>
      <p style="color:#555;margin-top:0;">Recibo de pagamento</p>
      <p>Olá ${escapeHtml(clientName)},</p>
      <p>Confirmamos o recebimento do seu pagamento. Seguem os detalhes:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#666;">Recibo</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${escapeHtml(receipt.receipt_number)}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Cobrança</td><td style="padding:6px 0;text-align:right;">${escapeHtml(chargeNumber)}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Descrição</td><td style="padding:6px 0;text-align:right;">${escapeHtml(description)}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Valor pago</td><td style="padding:6px 0;text-align:right;font-weight:bold;color:#0a7d3d;">${valorFormatado}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Forma de pagamento</td><td style="padding:6px 0;text-align:right;">${escapeHtml(formaPagamento)}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Data do pagamento</td><td style="padding:6px 0;text-align:right;">${escapeHtml(dataPagamento)}</td></tr>
      </table>
      <div style="text-align:center;margin:24px 0;">
        <a href="${publicLink}" style="background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Visualizar recibo</a>
      </div>
      <p style="font-size:12px;color:#888;">Ou copie e cole este link no navegador:<br /><a href="${publicLink}">${publicLink}</a></p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
      <p style="font-size:11px;color:#999;text-align:center;">Gerado pelo Smart Billing</p>
    </div>
  `;

  let sendStatus = 'sent';
  let errorMessage: string | null = null;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [recipientEmail],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      sendStatus = 'failed';
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody?.message || '';
      } catch { /* corpo de erro não-JSON, ignora */ }
      errorMessage = `Resend respondeu ${res.status}${detail ? `: ${detail}` : ''}`;
    }
  } catch {
    sendStatus = 'failed';
    errorMessage = 'Falha de rede ao contatar o serviço de e-mail.';
  }

  await adminClient.from('notification_logs').insert({
    company_id: receipt.company_id,
    charge_id: receipt.charge_id ?? null,
    channel: 'email',
    recipient: recipientEmail,
    status: sendStatus,
    message: sendStatus === 'sent' ? `Recibo ${receipt.receipt_number} enviado por e-mail` : null,
    error_message: errorMessage,
  });

  if (sendStatus !== 'sent') {
    logEvent({ receipt_number: receipt.receipt_number, error: 'send_failed' });
    return jsonResponse({ success: false, message: 'Não foi possível enviar o e-mail. Tente novamente.' }, 502);
  }

  logEvent({ receipt_number: receipt.receipt_number, status: 'sent' });
  return jsonResponse({ success: true, message: 'Recibo enviado por e-mail' });
});
