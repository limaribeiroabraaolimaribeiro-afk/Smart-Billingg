/* ==========================================================================
   Smart Billing — Integration configuration
   --------------------------------------------------------------------------
   Nenhuma chave SECRETA deve ser gravada neste arquivo. A "anon key" do
   Supabase é uma chave PÚBLICA (protegida por RLS) e pode ficar no
   front-end normalmente — mas a "service_role key" NUNCA pode aparecer
   aqui nem em nenhum arquivo servido ao navegador.

   Como configurar:
   1. Crie um projeto em https://supabase.com
   2. Rode sql/supabase_schema.sql inteiro no SQL Editor do projeto
   3. Em Project Settings → API, copie:
        - "Project URL"        → cole em supabaseUrl abaixo
        - "anon" / "publishable" key → cole em supabaseAnonKey abaixo
   4. Salve o arquivo. O sistema passa a usar o banco real automaticamente.

   Veja o passo a passo completo em SUPABASE_SETUP.md.
   ========================================================================== */

window.SMART_BILLING_CONFIG = (() => {
  const supabaseUrl = 'https://uhdmjgycsyvetrjhwcpy.supabase.co';
  const supabaseAnonKey = 'sb_publishable_Ag-AwAqJWfaB7wykzwHQLQ_z4uZxwfT';

  const hasCredentials = Boolean(
    supabaseUrl && supabaseAnonKey && /^https:\/\/.+\.supabase\.co\/?$/.test(supabaseUrl.trim()),
  );

  return {
    supabaseUrl,
    supabaseAnonKey,
    environment: 'development',

    infinitePay: {
      // Preenchido futuramente com o Client ID público do checkout.
      // A chave secreta da InfinitePay NUNCA deve ficar no frontend —
      // veja supabase/functions/ para onde ela deve morar.
      clientId: '',
    },

    // true automaticamente enquanto supabaseUrl/supabaseAnonKey não forem
    // preenchidos acima. Com o Supabase configurado, o app passa a usar
    // somente dados reais — os dados de demonstração deixam de aparecer.
    useDemoMode: !hasCredentials,
  };
})();
