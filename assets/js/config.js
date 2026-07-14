/* ==========================================================================
   Smart Billing — Integration configuration
   --------------------------------------------------------------------------
   Nenhuma chave ou segredo deve ser gravado neste arquivo.
   Em produção, estes valores devem vir de variáveis de ambiente injetadas
   no build (ex.: import.meta.env / process.env) ou de um endpoint de
   configuração servido pelo backend — nunca hardcoded no repositório.
   ========================================================================== */

window.SMART_BILLING_CONFIG = {
  supabase: {
    // Preenchido em runtime via variável de ambiente (ex.: SUPABASE_URL).
    url: window.__ENV__?.SUPABASE_URL || '',
    anonKey: window.__ENV__?.SUPABASE_ANON_KEY || '',
  },
  infinitePay: {
    // Preenchido em runtime via variável de ambiente (ex.: INFINITEPAY_CLIENT_ID).
    clientId: window.__ENV__?.INFINITEPAY_CLIENT_ID || '',
    // Chamadas autenticadas devem passar por uma function/serverless própria;
    // o client-id público apenas identifica o checkout, nunca a chave secreta.
  },
  // Enquanto as credenciais acima não são configuradas, o app roda em modo
  // demo com dados simulados persistidos em localStorage (ver data.js).
  demoMode: true,
};
