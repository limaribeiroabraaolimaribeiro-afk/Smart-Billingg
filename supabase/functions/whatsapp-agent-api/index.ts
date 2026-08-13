// ============================================================================
// whatsapp-agent-api
// ----------------------------------------------------------------------------
// API "curta" chamada pelo agente local de WhatsApp (Node.js, whatsapp-web.js
// rodando no computador do usuário — ver smart-billing-agent/). O agente NUNCA
// fala diretamente com o Postgres nem usa a anon key: toda comunicação passa
// por aqui, autenticada por um segredo compartilhado (header x-agent-token),
// nunca por um JWT de usuário — o agente é uma máquina, não uma sessão.
//
// Esta function não mantém conexão persistente nem estado em memória entre
// chamadas: cada ação é uma requisição HTTP curta e stateless. Toda leitura/
// escrita usa a service_role (ignora RLS) porque a autorização já foi feita
// pela comparação do token.
//
// Ações aceitas no corpo (JSON): { "action": "...", ... }
//   update_status      { company_id, status, phone_number?, display_name?, error_message? }
//   update_qr          { company_id, qr_code }
//   claim_jobs         { company_id, limit? }
//   acknowledge_sent    { company_id, id, whatsapp_message_id? }
//   acknowledge_failed  { company_id, id, error_message }
//   heartbeat          { company_id }
//   logout_complete     { company_id }
//
// Ações do WORKER de cobrança automática (VPS) — ainda não usadas em
// produção nesta etapa, preparadas para quando o worker for ligado:
//   list_reminder_candidates { company_id }
//     -> cobranças pendentes que precisam de lembrete HOJE (America/Sao_Paulo),
//        segundo whatsapp_settings (remind_3_days_before/remind_1_day_before/
//        remind_on_due_date/remind_when_overdue) — mesmas regras já usadas
//        pelo painel, nenhuma regra nova inventada aqui.
//   enqueue_reminder { company_id, charge_id, message_type, message, idempotency_key }
//     -> enfileira o lembrete de WhatsApp via enqueue_whatsapp_message_system()
//        (RPC restrita a service_role — ver sql/vps_worker_automation.sql).
//   send_email_reminder { company_id, charge_id, kind, idempotency_key }
//     -> envia o lembrete por e-mail via Resend, com o mesmo padrão de
//        idempotência (notification_logs.idempotency_key) e o mesmo modelo
//        de composição de send-receipt-email (nunca aceita conteúdo do
//        chamador — busca tudo do banco a partir de charge_id).
//
// Secrets exigidos (supabase secrets set):
//   WHATSAPP_AGENT_TOKEN — segredo compartilhado com smart-billing-agent/.env
//   RESEND_API_KEY, EMAIL_FROM, PUBLIC_APP_URL — apenas para
//     send_email_reminder (mesmos secrets já usados por send-receipt-email;
//     se ausentes, a ação responde "email_not_configured" sem derrubar o
//     worker nem as demais ações desta function).
//
// Variáveis automáticas de toda Edge Function:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const FN_NAME = 'whatsapp-agent-api';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_STATUSES = ['offline', 'starting', 'qr_required', 'authenticated', 'ready', 'disconnected', 'error'];
const REMINDER_MESSAGE_TYPES = ['due_soon_reminder', 'overdue_reminder'];
const REMINDER_KINDS = ['due_soon_3', 'due_soon_1', 'due_today', 'overdue'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function logEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: FN_NAME, ...fields, ts: new Date().toISOString() }));
}

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Comparação em tempo constante (evita vazar, por timing, quantos
// caracteres do token estão corretos).
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) {
    // Ainda percorre bufA inteiro para não vazar o tamanho por timing.
    let dummy = 0;
    for (let i = 0; i < bufA.length; i += 1) dummy |= bufA[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Helpers de timezone/formatação para os lembretes automáticos — tudo em
// America/Sao_Paulo explicitamente (o runtime da Edge Function roda em UTC
// por padrão; nunca comparar datas sem timeZone explícito).
// ---------------------------------------------------------------------------
const APP_TIMEZONE = 'America/Sao_Paulo';

function todayInAppTimezone(): string {
  // Formata "agora" (instante UTC) como YYYY-MM-DD já na timezone do Brasil.
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(new Date());
}

// Diferença em dias de calendário entre duas datas "YYYY-MM-DD" (sem horário
// envolvido — due_date já é uma coluna DATE pura no banco).
function daysBetween(fromDateStr: string, toDateStr: string): number {
  const from = new Date(`${fromDateStr}T00:00:00Z`);
  const to = new Date(`${toDateStr}T00:00:00Z`);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function formatCurrencyBRL(value: number): string {
  return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBR(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('pt-BR', { timeZone: APP_TIMEZONE });
}

function escapeHtml(str: string): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

const REMINDER_KIND_LABEL: Record<string, (dueDateBR: string) => string> = {
  due_soon_3: (dueDateBR) => `Sua cobrança vence em 3 dias, no dia ${dueDateBR}.`,
  due_soon_1: (dueDateBR) => `Sua cobrança vence amanhã (${dueDateBR}).`,
  due_today: () => 'Sua cobrança vence hoje.',
  overdue: (dueDateBR) => `Sua cobrança venceu em ${dueDateBR} e ainda não identificamos o pagamento.`,
};

// Mapeia o "kind" (granularidade usada pelo worker) para o enum
// whatsapp_message_type já existente no banco.
function messageTypeForKind(kind: string): string {
  return kind === 'overdue' ? 'overdue_reminder' : 'due_soon_reminder';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Método não permitido.' }, 405);
  }

  const WHATSAPP_AGENT_TOKEN = Deno.env.get('WHATSAPP_AGENT_TOKEN') ?? '';
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (!WHATSAPP_AGENT_TOKEN) {
    logEvent({ error: 'missing_secret' });
    return jsonResponse({ success: false, message: 'Agente ainda não configurado no servidor.' }, 500);
  }

  const providedToken = req.headers.get('x-agent-token') || '';
  if (!providedToken || !timingSafeEqual(providedToken, WHATSAPP_AGENT_TOKEN)) {
    logEvent({ error: 'invalid_token' });
    return jsonResponse({ success: false, message: 'Token inválido.' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, message: 'Corpo da requisição inválido.' }, 400);
  }

  const action = body?.action;
  const companyId = body?.company_id;
  if (!isValidUuid(companyId)) {
    return jsonResponse({ success: false, message: 'company_id inválido.' }, 400);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const now = new Date().toISOString();

  try {
    switch (action) {
      case 'update_status': {
        const status = body?.status as string;
        if (!AGENT_STATUSES.includes(status)) {
          return jsonResponse({ success: false, message: 'status inválido.' }, 400);
        }
        const patch: Record<string, unknown> = {
          company_id: companyId,
          status,
          last_seen_at: now,
        };
        if (typeof body?.phone_number === 'string') patch.phone_number = body.phone_number;
        if (typeof body?.display_name === 'string') patch.display_name = body.display_name;
        patch.error_message = status === 'error' && typeof body?.error_message === 'string' ? body.error_message : null;
        if (status === 'ready') patch.connected_at = now;
        if (status === 'disconnected' || status === 'error') patch.disconnected_at = now;
        // O QR só faz sentido enquanto status === 'qr_required'; em qualquer
        // outra transição, apaga o QR antigo (nunca guarda QR obsoleto).
        if (status !== 'qr_required') patch.qr_code = null;

        const { error } = await adminClient.from('whatsapp_agent_state').upsert(patch, { onConflict: 'company_id' });
        if (error) throw error;
        logEvent({ action, company_id: companyId, status });
        return jsonResponse({ success: true });
      }

      case 'update_qr': {
        const qrCode = body?.qr_code;
        if (typeof qrCode !== 'string' || qrCode.length === 0 || qrCode.length > 200_000) {
          return jsonResponse({ success: false, message: 'qr_code inválido.' }, 400);
        }
        const { error } = await adminClient.from('whatsapp_agent_state').upsert({
          company_id: companyId,
          status: 'qr_required',
          qr_code: qrCode,
          error_message: null,
          last_seen_at: now,
        }, { onConflict: 'company_id' });
        if (error) throw error;
        logEvent({ action, company_id: companyId });
        return jsonResponse({ success: true });
      }

      case 'heartbeat': {
        const { error } = await adminClient.from('whatsapp_agent_state').upsert({
          company_id: companyId,
          last_seen_at: now,
        }, { onConflict: 'company_id', ignoreDuplicates: false });
        if (error) throw error;
        return jsonResponse({ success: true });
      }

      case 'logout_complete': {
        const { error } = await adminClient.from('whatsapp_agent_state').upsert({
          company_id: companyId,
          status: 'offline',
          qr_code: null,
          phone_number: null,
          display_name: null,
          error_message: null,
          disconnected_at: now,
          last_seen_at: now,
        }, { onConflict: 'company_id' });
        if (error) throw error;
        logEvent({ action, company_id: companyId });
        return jsonResponse({ success: true });
      }

      case 'claim_jobs': {
        const limitRaw = Number(body?.limit ?? 5);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 20) : 5;
        const { data, error } = await adminClient.rpc('claim_whatsapp_jobs', {
          p_company_id: companyId,
          p_limit: limit,
        });
        if (error) throw error;
        return jsonResponse({ success: true, jobs: data || [] });
      }

      case 'acknowledge_sent': {
        const id = body?.id;
        if (!isValidUuid(id)) return jsonResponse({ success: false, message: 'id inválido.' }, 400);
        const patch: Record<string, unknown> = { status: 'sent', sent_at: now, error_message: null };
        if (typeof body?.whatsapp_message_id === 'string') patch.whatsapp_message_id = body.whatsapp_message_id;
        const { error } = await adminClient.from('whatsapp_outbox').update(patch)
          .eq('id', id).eq('company_id', companyId);
        if (error) throw error;
        return jsonResponse({ success: true });
      }

      case 'acknowledge_failed': {
        const id = body?.id;
        if (!isValidUuid(id)) return jsonResponse({ success: false, message: 'id inválido.' }, 400);
        const errorMessage = typeof body?.error_message === 'string' ? body.error_message.slice(0, 500) : 'Falha desconhecida.';

        const { data: job, error: fetchErr } = await adminClient.from('whatsapp_outbox')
          .select('attempts, max_attempts')
          .eq('id', id).eq('company_id', companyId).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!job) return jsonResponse({ success: false, message: 'Mensagem não encontrada.' }, 404);

        const exhausted = job.attempts >= job.max_attempts;
        const patch: Record<string, unknown> = exhausted
          ? { status: 'failed', failed_at: now, error_message: errorMessage }
          // Ainda há tentativas: volta para pending com um pequeno atraso
          // (evita martelar um número/serviço instável em loop apertado).
          : { status: 'pending', error_message: errorMessage, scheduled_at: new Date(Date.now() + 30_000).toISOString() };

        const { error } = await adminClient.from('whatsapp_outbox').update(patch)
          .eq('id', id).eq('company_id', companyId);
        if (error) throw error;
        return jsonResponse({ success: true, exhausted });
      }

      case 'list_reminder_candidates': {
        const { data: settings, error: settingsErr } = await adminClient
          .from('whatsapp_settings')
          .select('remind_3_days_before, remind_1_day_before, remind_on_due_date, remind_when_overdue, email_reminders_enabled')
          .eq('company_id', companyId)
          .maybeSingle();
        if (settingsErr) throw settingsErr;

        // Nenhuma preferência marcada: nada a fazer (evita consultar charges à toa).
        if (!settings || (!settings.remind_3_days_before && !settings.remind_1_day_before
          && !settings.remind_on_due_date && !settings.remind_when_overdue)) {
          return jsonResponse({ success: true, today: todayInAppTimezone(), candidates: [] });
        }

        const today = todayInAppTimezone();

        const { data: charges, error: chargesErr } = await adminClient
          .from('charges')
          .select(`
            id, charge_number, description, amount, due_date, public_token,
            client:clients(id, name, whatsapp, email)
          `)
          .eq('company_id', companyId)
          .eq('status', 'pending')
          .not('client_id', 'is', null);
        if (chargesErr) throw chargesErr;

        const { data: company } = await adminClient.from('companies').select('name').eq('id', companyId).maybeSingle();
        const companyName = company?.name || 'Smart Billing';

        const candidates: unknown[] = [];
        for (const charge of charges || []) {
          const client = charge.client as { id?: string; name?: string; whatsapp?: string; email?: string } | null;
          if (!client?.whatsapp) continue; // sem WhatsApp cadastrado: nada a enviar

          const diff = daysBetween(today, charge.due_date as string);
          let kind: string | null = null;
          if (diff === 3 && settings.remind_3_days_before) kind = 'due_soon_3';
          else if (diff === 1 && settings.remind_1_day_before) kind = 'due_soon_1';
          else if (diff === 0 && settings.remind_on_due_date) kind = 'due_today';
          else if (diff < 0 && settings.remind_when_overdue) kind = 'overdue';
          if (!kind) continue;

          const emailEnabled = Boolean(settings.email_reminders_enabled) && EMAIL_RE.test(client.email || '');

          candidates.push({
            kind,
            message_type: messageTypeForKind(kind),
            charge: {
              id: charge.id,
              charge_number: charge.charge_number,
              description: charge.description,
              amount: charge.amount,
              due_date: charge.due_date,
              public_token: charge.public_token,
            },
            client: { id: client.id, name: client.name, has_email: emailEnabled },
            company_name: companyName,
            whatsapp_idempotency_key: `reminder:${charge.id}:${kind}`,
            email_idempotency_key: emailEnabled ? `email-reminder:${charge.id}:${kind}` : null,
          });
        }

        return jsonResponse({ success: true, today, candidates });
      }

      case 'enqueue_reminder': {
        const chargeId = body?.charge_id;
        const messageType = body?.message_type as string;
        const message = body?.message;
        const idempotencyKey = body?.idempotency_key;
        if (!isValidUuid(chargeId)) return jsonResponse({ success: false, message: 'charge_id inválido.' }, 400);
        if (!REMINDER_MESSAGE_TYPES.includes(messageType)) return jsonResponse({ success: false, message: 'message_type inválido.' }, 400);
        if (typeof message !== 'string' || !message.trim()) return jsonResponse({ success: false, message: 'message inválida.' }, 400);
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return jsonResponse({ success: false, message: 'idempotency_key inválida.' }, 400);

        const { data, error } = await adminClient.rpc('enqueue_whatsapp_message_system', {
          p_company_id: companyId,
          p_charge_id: chargeId,
          p_message_type: messageType,
          p_message: message,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        logEvent({ action, company_id: companyId, charge_id: chargeId, message_type: messageType });
        return jsonResponse({ success: true, job: data });
      }

      case 'send_email_reminder': {
        const chargeId = body?.charge_id;
        const kind = body?.kind as string;
        const idempotencyKey = body?.idempotency_key;
        if (!isValidUuid(chargeId)) return jsonResponse({ success: false, message: 'charge_id inválido.' }, 400);
        if (!REMINDER_KINDS.includes(kind)) return jsonResponse({ success: false, message: 'kind inválido.' }, 400);
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return jsonResponse({ success: false, message: 'idempotency_key inválida.' }, 400);

        const { data: charge, error: chargeErr } = await adminClient
          .from('charges')
          .select('id, charge_number, description, amount, due_date, public_token, status, client:clients(name, email)')
          .eq('id', chargeId).eq('company_id', companyId).maybeSingle();
        if (chargeErr) throw chargeErr;
        if (!charge) return jsonResponse({ success: false, message: 'Cobrança não encontrada.' }, 404);

        // Confirma de novo, agora, que a cobrança ainda está pendente — fecha
        // a mesma janela de corrida do lado do WhatsApp (cliente pode ter
        // pago entre o worker listar candidatos e chegar aqui).
        if (charge.status !== 'pending') {
          await adminClient.from('notification_logs').insert({
            company_id: companyId,
            charge_id: chargeId,
            channel: 'email',
            recipient: null,
            status: 'skipped',
            error_message: `Cobrança não está mais pendente (status atual: ${charge.status}).`,
            idempotency_key: idempotencyKey,
          }).select().maybeSingle();
          return jsonResponse({ success: true, skipped: 'not_pending' });
        }

        const client = charge.client as { name?: string; email?: string } | null;
        const recipientEmail = client?.email;

        if (!EMAIL_RE.test(recipientEmail || '')) {
          // Sem e-mail válido: registra e segue em frente — nunca derruba o worker.
          await adminClient.from('notification_logs').insert({
            company_id: companyId,
            charge_id: chargeId,
            channel: 'email',
            recipient: null,
            status: 'skipped',
            error_message: 'Cliente sem e-mail cadastrado.',
            idempotency_key: idempotencyKey,
          }).select().maybeSingle(); // maybeSingle: idempotency_key já pode existir de um ciclo anterior — ignora silenciosamente
          return jsonResponse({ success: true, skipped: 'no_email' });
        }

        // Reivindica o envio de forma atômica: se idempotency_key já existir,
        // o upsert com ignoreDuplicates não retorna linha — sinal de que já
        // foi processado (ou está sendo processado agora) e não deve repetir.
        const { data: claimed, error: claimErr } = await adminClient
          .from('notification_logs')
          .upsert({
            company_id: companyId,
            charge_id: chargeId,
            channel: 'email',
            recipient: recipientEmail,
            status: 'pending',
            idempotency_key: idempotencyKey,
          }, { onConflict: 'idempotency_key', ignoreDuplicates: true })
          .select('id')
          .maybeSingle();
        if (claimErr) throw claimErr;
        if (!claimed) {
          return jsonResponse({ success: true, alreadyProcessed: true });
        }

        const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
        const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? '';
        const PUBLIC_APP_URL = (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '');

        if (!RESEND_API_KEY || !EMAIL_FROM || !PUBLIC_APP_URL) {
          await adminClient.from('notification_logs').update({
            status: 'failed',
            error_message: 'Serviço de e-mail não configurado (RESEND_API_KEY/EMAIL_FROM/PUBLIC_APP_URL).',
          }).eq('id', claimed.id);
          logEvent({ action, company_id: companyId, charge_id: chargeId, error: 'email_not_configured' });
          return jsonResponse({ success: true, skipped: 'email_not_configured' });
        }

        const { data: company } = await adminClient.from('companies').select('name').eq('id', companyId).maybeSingle();
        const companyName = company?.name || 'Smart Billing';
        const clientName = client?.name || 'Cliente';
        const dueDateBR = formatDateBR(charge.due_date as string);
        const label = (REMINDER_KIND_LABEL[kind] || REMINDER_KIND_LABEL.due_today)(dueDateBR);
        const publicLink = `${PUBLIC_APP_URL}/cobranca-publica.html?token=${charge.public_token}`;
        const subject = kind === 'overdue'
          ? `Cobrança em atraso — ${companyName}`
          : `Lembrete de cobrança — vencimento ${dueDateBR}`;

        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
            <h2 style="margin-bottom:4px;">${escapeHtml(companyName)}</h2>
            <p style="color:#555;margin-top:0;">Lembrete de cobrança</p>
            <p>Olá ${escapeHtml(clientName)},</p>
            <p>${escapeHtml(label)}</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:6px 0;color:#666;">Cobrança</td><td style="padding:6px 0;text-align:right;">${escapeHtml(charge.charge_number as string || '—')}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Descrição</td><td style="padding:6px 0;text-align:right;">${escapeHtml(charge.description as string || '')}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Valor</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${formatCurrencyBRL(Number(charge.amount))}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Vencimento</td><td style="padding:6px 0;text-align:right;">${dueDateBR}</td></tr>
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${publicLink}" style="background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Visualizar e pagar</a>
            </div>
            <p style="font-size:12px;color:#888;">Ou copie e cole este link no navegador:<br /><a href="${publicLink}">${publicLink}</a></p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
            <p style="font-size:11px;color:#999;text-align:center;">Mensagem automática enviada pelo Smart Billing.</p>
          </div>
        `;

        let sendStatus = 'sent';
        let errorMessage: string | null = null;
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: EMAIL_FROM, to: [recipientEmail], subject, html }),
          });
          if (!res.ok) {
            sendStatus = 'failed';
            let detail = '';
            try { detail = (await res.json())?.message || ''; } catch { /* corpo não-JSON */ }
            errorMessage = `Resend respondeu ${res.status}${detail ? `: ${detail}` : ''}`;
          }
        } catch {
          sendStatus = 'failed';
          errorMessage = 'Falha de rede ao contatar o serviço de e-mail.';
        }

        await adminClient.from('notification_logs').update({
          status: sendStatus,
          message: sendStatus === 'sent' ? `Lembrete (${kind}) da cobrança ${charge.charge_number} enviado por e-mail` : null,
          error_message: errorMessage,
        }).eq('id', claimed.id);

        logEvent({ action, company_id: companyId, charge_id: chargeId, kind, status: sendStatus });
        return jsonResponse({ success: sendStatus === 'sent', status: sendStatus, message: errorMessage || undefined });
      }

      default:
        return jsonResponse({ success: false, message: 'Ação desconhecida.' }, 400);
    }
  } catch (err) {
    logEvent({ action, company_id: companyId, error: 'internal_error', detail: err instanceof Error ? err.message : String(err) });
    return jsonResponse({ success: false, message: 'Erro interno ao processar a ação.' }, 500);
  }
});
