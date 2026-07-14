// ============================================================================
// infinitepay-webhook — ESQUELETO (não implementado)
// ----------------------------------------------------------------------------
// Objetivo futuro: receber notificações de pagamento da InfinitePay,
// registrar o evento bruto em public.webhook_events (deduplicado por
// unique (provider, event_id)) e, se aprovado, gravar o payment/receipt e
// atualizar a charge — o mesmo efeito de register_manual_payment(), mas
// disparado pelo gateway em vez de uma ação manual do painel.
//
// Este arquivo NÃO deve ser deployado como está — falta a validação real da
// assinatura do webhook e o parsing do payload da InfinitePay.
//
// Segredos necessários (nunca hardcode — usar supabase secrets set):
//   INFINITEPAY_WEBHOOK_SECRET
//
// Deploy necessário com --no-verify-jwt (quem chama é a InfinitePay, não um
// usuário logado) — a autenticidade deve ser validada manualmente usando o
// segredo/assinatura enviado pela InfinitePay no cabeçalho da requisição.
// ============================================================================

// import { createClient } from 'npm:@supabase/supabase-js@2';

// Deno.serve(async (req: Request) => {
//   // 1. Ler o corpo bruto da requisição (payload da InfinitePay).
//   // 2. Validar a assinatura/segredo do webhook (NÃO IMPLEMENTADO).
//   // 3. Gravar o evento em public.webhook_events (provider, event_id,
//   //    event_type, payload) usando a service_role — se já existir
//   //    (provider, event_id), ignorar silenciosamente (evita duplicidade).
//   // 4. Se o evento indicar pagamento aprovado:
//   //      - localizar a charge pelo provider_reference;
//   //      - inserir em public.payments (status = 'approved');
//   //      - inserir o public.receipts correspondente;
//   //      - atualizar public.charges (status = 'paid', paid_at = now()).
//   // 5. Marcar webhook_events.processed = true (ou gravar error_message).
//   // 6. Responder 200 rapidamente (gateways costumam reenviar em caso de erro/timeout).
//
//   return new Response(
//     JSON.stringify({ error: 'infinitepay-webhook ainda não foi implementada.' }),
//     { status: 501, headers: { 'Content-Type': 'application/json' } },
//   );
// });

export {};
