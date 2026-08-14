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
// Ações do WORKER de cobrança automática (VPS):
//   list_reminder_candidates { company_id }
//     -> AGRUPADO POR CLIENTE: no máximo 1 entrada por cliente, mesmo que
//        ele tenha várias cobranças elegíveis para lembrete HOJE
//        (America/Sao_Paulo), segundo whatsapp_settings
//        (remind_3_days_before/remind_1_day_before/remind_on_due_date/
//        remind_when_overdue) — mesmas regras já usadas pelo painel,
//        nenhuma regra nova de DATA foi inventada; a única regra nova é
//        "no máximo 1 mensagem automática por cliente por dia", que agrupa
//        as cobranças desse cliente num único resumo.
//   enqueue_daily_reminder { company_id, client_id, charge_ids[], message }
//     -> enfileira o resumo diário de WhatsApp via
//        enqueue_daily_reminder_system() (RPC restrita a service_role — ver
//        sql/fix_daily_reminder_dedup.sql). A idempotency_key é SEMPRE
//        calculada aqui, a partir de company_id+client_id+dia local do
//        SERVIDOR — nunca aceita do worker, para garantir "no máximo 1 por
//        cliente por dia" mesmo que o worker tenha algum bug de fuso.
//   send_daily_email_reminder { company_id, client_id, charge_ids[] }
//     -> envia o resumo diário por e-mail via Resend, com o mesmo padrão de
//        idempotência (notification_logs.idempotency_key, também calculada
//        aqui, nunca aceita do chamador) e o mesmo modelo de composição de
//        send-receipt-email (nunca aceita conteúdo do chamador — busca tudo
//        do banco a partir de client_id/charge_ids).
//
// Secrets exigidos (supabase secrets set):
//   WHATSAPP_AGENT_TOKEN — segredo compartilhado com smart-billing-agent/.env
//   RESEND_API_KEY, EMAIL_FROM, PUBLIC_APP_URL — apenas para
//     send_daily_email_reminder (mesmos secrets já usados por
//     send-receipt-email; se ausentes, a ação responde
//     "email_not_configured" sem derrubar o worker nem as demais ações
//     desta function).
//
// Variáveis automáticas de toda Edge Function:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const FN_NAME = 'whatsapp-agent-api';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_STATUSES = ['offline', 'starting', 'qr_required', 'authenticated', 'ready', 'disconnected', 'error'];
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

// kind = granularidade de "quão urgente" é uma cobrança em relação a hoje.
// Usado tanto para ordenar as cobranças dentro do resumo (mais urgente
// primeiro) quanto para rotular cada linha (WhatsApp e e-mail).
const KIND_PRIORITY: Record<string, number> = { overdue: 0, due_today: 1, due_soon_1: 2, due_soon_3: 3 };
const REMINDER_KIND_SHORT_LABEL: Record<string, string> = {
  overdue: 'vencida',
  due_today: 'vence hoje',
  due_soon_1: 'vence amanhã',
  due_soon_3: 'vence em 3 dias',
};

function kindForDiff(diff: number): string | null {
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'due_today';
  if (diff === 1) return 'due_soon_1';
  if (diff === 3) return 'due_soon_3';
  return null;
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

        // Agrupa por client_id: NO MÁXIMO 1 candidato por cliente, mesmo que
        // ele tenha várias cobranças elegíveis hoje — é isso que garante,
        // já na origem dos dados, que o worker nunca vai montar mais de uma
        // mensagem automática por cliente por dia.
        type ClientInfo = { id: string; name?: string; whatsapp?: string; email?: string };
        type ChargeItem = { id: string; charge_number: string; description: string; amount: number; due_date: string; public_token: string; kind: string; label: string };
        const byClient = new Map<string, { client: ClientInfo; charges: ChargeItem[] }>();

        for (const charge of charges || []) {
          const client = charge.client as ClientInfo | null;
          if (!client?.id || !client.whatsapp) continue; // sem WhatsApp cadastrado: nada a enviar

          const diff = daysBetween(today, charge.due_date as string);
          const kind = kindForDiff(diff);
          if (!kind) continue;
          if (kind === 'due_soon_3' && !settings.remind_3_days_before) continue;
          if (kind === 'due_soon_1' && !settings.remind_1_day_before) continue;
          if (kind === 'due_today' && !settings.remind_on_due_date) continue;
          if (kind === 'overdue' && !settings.remind_when_overdue) continue;

          if (!byClient.has(client.id)) byClient.set(client.id, { client, charges: [] });
          byClient.get(client.id)!.charges.push({
            id: charge.id as string,
            charge_number: charge.charge_number as string,
            description: charge.description as string,
            amount: Number(charge.amount),
            due_date: charge.due_date as string,
            public_token: charge.public_token as string,
            kind,
            label: REMINDER_KIND_SHORT_LABEL[kind],
          });
        }

        const candidates: unknown[] = [];
        for (const { client, charges: clientCharges } of byClient.values()) {
          clientCharges.sort((a, b) => {
            const rank = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
            return rank !== 0 ? rank : a.due_date.localeCompare(b.due_date);
          });
          const emailEnabled = Boolean(settings.email_reminders_enabled) && EMAIL_RE.test(client.email || '');
          candidates.push({
            client: { id: client.id, name: client.name, has_email: emailEnabled },
            company_name: companyName,
            charges: clientCharges,
          });
        }

        return jsonResponse({ success: true, today, candidates });
      }

      case 'enqueue_daily_reminder': {
        const clientId = body?.client_id;
        const chargeIds = body?.charge_ids;
        const message = body?.message;
        if (!isValidUuid(clientId)) return jsonResponse({ success: false, message: 'client_id inválido.' }, 400);
        if (!Array.isArray(chargeIds) || chargeIds.length === 0 || !chargeIds.every(isValidUuid)) {
          return jsonResponse({ success: false, message: 'charge_ids inválido.' }, 400);
        }
        if (typeof message !== 'string' || !message.trim()) return jsonResponse({ success: false, message: 'message inválida.' }, 400);

        // A idempotency_key é SEMPRE calculada aqui, no servidor, a partir de
        // company_id + client_id + dia local (America/Sao_Paulo) — nunca
        // aceita do worker. É essa chave, com a constraint UNIQUE de
        // whatsapp_outbox.idempotency_key, que garante no banco (não só em
        // memória) no máximo 1 lembrete automático por cliente por dia,
        // mesmo com ciclos concorrentes ou repetidos.
        const idempotencyKey = `daily-reminder:${companyId}:${clientId}:${todayInAppTimezone()}`;

        const { data, error } = await adminClient.rpc('enqueue_daily_reminder_system', {
          p_company_id: companyId,
          p_client_id: clientId,
          p_charge_ids: chargeIds,
          p_message: message,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        logEvent({ action, company_id: companyId, client_id: clientId, charges: chargeIds.length });
        return jsonResponse({ success: true, job: data });
      }

      case 'send_daily_email_reminder': {
        const clientId = body?.client_id;
        const chargeIds = body?.charge_ids;
        if (!isValidUuid(clientId)) return jsonResponse({ success: false, message: 'client_id inválido.' }, 400);
        if (!Array.isArray(chargeIds) || chargeIds.length === 0 || !chargeIds.every(isValidUuid)) {
          return jsonResponse({ success: false, message: 'charge_ids inválido.' }, 400);
        }

        // Mesma lógica de chave: sempre calculada aqui, nunca aceita do worker.
        const idempotencyKey = `email-daily-reminder:${companyId}:${clientId}:${todayInAppTimezone()}`;

        const { data: client, error: clientErr } = await adminClient
          .from('clients').select('name, email').eq('id', clientId).eq('company_id', companyId).maybeSingle();
        if (clientErr) throw clientErr;
        if (!client) return jsonResponse({ success: false, message: 'Cliente não encontrado.' }, 404);

        if (!EMAIL_RE.test(client.email || '')) {
          await adminClient.from('notification_logs').insert({
            company_id: companyId,
            charge_id: null,
            channel: 'email',
            recipient: null,
            status: 'skipped',
            error_message: 'Cliente sem e-mail cadastrado.',
            idempotency_key: idempotencyKey,
          }).select().maybeSingle(); // maybeSingle: idempotency_key já pode existir de um ciclo anterior — ignora silenciosamente
          return jsonResponse({ success: true, skipped: 'no_email' });
        }

        // Confirma de novo, agora, que TODAS as cobranças do resumo ainda
        // pertencem a este cliente/empresa e continuam pendentes — nunca
        // envia um resumo desatualizado (cliente pode ter pago uma delas
        // entre o worker listar candidatos e chegar aqui).
        const { data: charges, error: chargesErr } = await adminClient
          .from('charges')
          .select('id, charge_number, description, amount, due_date, public_token, status')
          .in('id', chargeIds)
          .eq('company_id', companyId)
          .eq('client_id', clientId);
        if (chargesErr) throw chargesErr;

        const pendingCharges = (charges || []).filter((c) => c.status === 'pending');
        if (pendingCharges.length === 0 || pendingCharges.length !== chargeIds.length) {
          await adminClient.from('notification_logs').insert({
            company_id: companyId,
            charge_id: pendingCharges[0]?.id ?? null,
            channel: 'email',
            recipient: client.email,
            status: 'skipped',
            error_message: 'Uma ou mais cobranças do resumo não estão mais pendentes.',
            idempotency_key: idempotencyKey,
          }).select().maybeSingle();
          return jsonResponse({ success: true, skipped: 'not_pending' });
        }

        // Reivindica o envio de forma atômica: se idempotency_key já existir,
        // o upsert com ignoreDuplicates não retorna linha — sinal de que já
        // foi processado (ou está sendo processado agora) e não deve repetir.
        const { data: claimed, error: claimErr } = await adminClient
          .from('notification_logs')
          .upsert({
            company_id: companyId,
            charge_id: pendingCharges[0].id,
            channel: 'email',
            recipient: client.email,
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
          logEvent({ action, company_id: companyId, client_id: clientId, error: 'email_not_configured' });
          return jsonResponse({ success: true, skipped: 'email_not_configured' });
        }

        const { data: company } = await adminClient.from('companies').select('name').eq('id', companyId).maybeSingle();
        const companyName = company?.name || 'Smart Billing';
        const clientName = client.name || 'Cliente';
        const today = todayInAppTimezone();

        const sortedCharges = [...pendingCharges].sort((a, b) => {
          const diffA = daysBetween(today, a.due_date as string);
          const diffB = daysBetween(today, b.due_date as string);
          return diffA - diffB;
        });

        const rowsHtml = sortedCharges.map((c) => {
          const diff = daysBetween(today, c.due_date as string);
          const kind = kindForDiff(diff) || 'due_soon_3';
          const label = REMINDER_KIND_SHORT_LABEL[kind] || '';
          const link = `${PUBLIC_APP_URL}/cobranca-publica.html?token=${c.public_token}`;
          return `<tr>
            <td style="padding:6px 8px 6px 0;color:#666;">${escapeHtml(c.charge_number as string || '—')}</td>
            <td style="padding:6px 8px;">${escapeHtml(c.description as string || '')}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:bold;white-space:nowrap;">${formatCurrencyBRL(Number(c.amount))}</td>
            <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${escapeHtml(label)}</td>
            <td style="padding:6px 0 6px 8px;text-align:right;"><a href="${link}">Pagar</a></td>
          </tr>`;
        }).join('');

        const subject = pendingCharges.length > 1
          ? `Você tem ${pendingCharges.length} cobranças pendentes — ${companyName}`
          : `Lembrete de cobrança — ${companyName}`;

        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
            <h2 style="margin-bottom:4px;">${escapeHtml(companyName)}</h2>
            <p style="color:#555;margin-top:0;">Lembrete de cobrança</p>
            <p>Olá ${escapeHtml(clientName)},</p>
            <p>Você possui ${pendingCharges.length} cobrança${pendingCharges.length > 1 ? 's' : ''} pendente${pendingCharges.length > 1 ? 's' : ''}:</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <thead>
                <tr style="text-align:left;color:#999;font-size:11px;text-transform:uppercase;">
                  <th style="padding:0 8px 6px 0;">Cobrança</th>
                  <th style="padding:0 8px 6px;">Descrição</th>
                  <th style="padding:0 8px 6px;text-align:right;">Valor</th>
                  <th style="padding:0 8px 6px;text-align:right;">Situação</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
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
            body: JSON.stringify({ from: EMAIL_FROM, to: [client.email], subject, html }),
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
          message: sendStatus === 'sent' ? `Resumo diário (${pendingCharges.length} cobrança(s)) enviado por e-mail` : null,
          error_message: errorMessage,
        }).eq('id', claimed.id);

        logEvent({ action, company_id: companyId, client_id: clientId, charges: pendingCharges.length, status: sendStatus });
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
