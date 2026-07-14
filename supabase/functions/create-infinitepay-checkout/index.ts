// ============================================================================
// create-infinitepay-checkout — ESQUELETO (não implementado)
// ----------------------------------------------------------------------------
// Objetivo futuro: receber um charge_id, criar o checkout correspondente na
// API da InfinitePay e salvar a checkout_url retornada em public.charges.
//
// Este arquivo NÃO deve ser deployado como está — falta a chamada real à
// InfinitePay e a leitura segura do segredo de API. Ele existe apenas para
// documentar o contrato de entrada/saída esperado.
//
// Segredos necessários (nunca hardcode — usar supabase secrets set):
//   INFINITEPAY_API_KEY
//
// Variáveis de ambiente já disponíveis automaticamente em toda Edge Function:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

// import { createClient } from 'npm:@supabase/supabase-js@2';

// Deno.serve(async (req: Request) => {
//   // 1. Validar método e autenticação do usuário (JWT do Supabase Auth).
//   // 2. Ler { charge_id } do corpo da requisição.
//   // 3. Buscar a charge no banco (usando a service_role) e validar:
//   //    - pertence à empresa do usuário autenticado;
//   //    - status ainda é 'pending';
//   //    - ainda não possui checkout_url.
//   // 4. Chamar a API da InfinitePay para criar o checkout (NÃO IMPLEMENTADO).
//   // 5. Salvar checkout_url e provider_reference em public.charges.
//   // 6. Responder { checkout_url } para o frontend redirecionar o cliente.
//
//   return new Response(
//     JSON.stringify({ error: 'create-infinitepay-checkout ainda não foi implementada.' }),
//     { status: 501, headers: { 'Content-Type': 'application/json' } },
//   );
// });

export {};
