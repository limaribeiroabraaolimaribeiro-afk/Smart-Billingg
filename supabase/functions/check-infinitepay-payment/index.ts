// ============================================================================
// check-infinitepay-payment — ESQUELETO (não implementado)
// ----------------------------------------------------------------------------
// Objetivo futuro: consultar diretamente a API da InfinitePay o status atual
// de um pagamento — usado como fallback quando o webhook não chegar (ex.:
// botão "Verificar pagamento" no painel, ou um cron periódico).
//
// Este arquivo NÃO deve ser deployado como está — falta a chamada real à
// API de consulta da InfinitePay.
//
// Segredos necessários (nunca hardcode — usar supabase secrets set):
//   INFINITEPAY_API_KEY
// ============================================================================

// import { createClient } from 'npm:@supabase/supabase-js@2';

// Deno.serve(async (req: Request) => {
//   // 1. Validar autenticação do usuário (JWT do Supabase Auth) e que a
//   //    charge pertence à empresa do usuário.
//   // 2. Ler { charge_id } do corpo da requisição.
//   // 3. Consultar a API da InfinitePay usando provider_reference (NÃO IMPLEMENTADO).
//   // 4. Se o status remoto indicar aprovado e ainda não refletido no banco,
//   //    aplicar a mesma lógica do webhook (payments + receipts + charges).
//   // 5. Responder com o status atual normalizado.
//
//   return new Response(
//     JSON.stringify({ error: 'check-infinitepay-payment ainda não foi implementada.' }),
//     { status: 501, headers: { 'Content-Type': 'application/json' } },
//   );
// });

export {};
