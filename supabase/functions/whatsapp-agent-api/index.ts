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
// Secrets exigidos (supabase secrets set):
//   WHATSAPP_AGENT_TOKEN — segredo compartilhado com smart-billing-agent/.env
//
// Variáveis automáticas de toda Edge Function:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const FN_NAME = 'whatsapp-agent-api';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_STATUSES = ['offline', 'starting', 'qr_required', 'authenticated', 'ready', 'disconnected', 'error'];

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

      default:
        return jsonResponse({ success: false, message: 'Ação desconhecida.' }, 400);
    }
  } catch (err) {
    logEvent({ action, company_id: companyId, error: 'internal_error', detail: err instanceof Error ? err.message : String(err) });
    return jsonResponse({ success: false, message: 'Erro interno ao processar a ação.' }, 500);
  }
});
