/* ==========================================================================
   Smart Billing — Cliente Supabase (inicializado uma única vez)
   --------------------------------------------------------------------------
   Depende da biblioteca oficial carregada via CDN (ver <head> de cada
   página): https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2
   Se o Supabase não estiver configurado (config.js → useDemoMode: true),
   `SB_SUPABASE.client` permanece null e o restante do app usa o modo demo.
   ========================================================================== */

const SB_SUPABASE = (() => {
  const cfg = window.SMART_BILLING_CONFIG || {};
  let client = null;

  const canInit = !cfg.useDemoMode
    && cfg.supabaseUrl
    && cfg.supabaseAnonKey
    && typeof window.supabase?.createClient === 'function';

  if (canInit) {
    try {
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'smart-billing-auth',
        },
      });
    } catch (err) {
      console.error('Falha ao inicializar o cliente Supabase:', err);
      client = null;
    }
  }

  return {
    client,
    isConfigured: Boolean(client),
  };
})();
