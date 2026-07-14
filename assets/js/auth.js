/* ==========================================================================
   Smart Billing — Autenticação (Supabase Auth) + guarda de rotas
   --------------------------------------------------------------------------
   Em modo demo (SMART_BILLING_CONFIG.useDemoMode === true) nenhuma sessão
   real é exigida: as páginas privadas continuam acessíveis com os dados
   simulados, para facilitar testes sem configurar o Supabase.
   Quando o Supabase está configurado, todas as páginas privadas exigem uma
   sessão válida — do contrário o usuário é redirecionado para login.html.
   ========================================================================== */

const SB_AUTH = (() => {
  const cfg = window.SMART_BILLING_CONFIG || {};

  function client() {
    return SB_SUPABASE?.client || null;
  }

  const ERROR_MESSAGES = {
    'Invalid login credentials': 'E-mail ou senha incorretos.',
    'Email not confirmed': 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.',
    'User already registered': 'Já existe uma conta cadastrada com este e-mail.',
    'Password should be at least 6 characters': 'A senha deve ter pelo menos 6 caracteres.',
    'Unable to validate email address: invalid format': 'Informe um e-mail válido.',
    'For security purposes, you can only request this after some seconds.': 'Aguarde alguns segundos antes de tentar novamente.',
  };

  function friendlyError(err) {
    const raw = err?.message || String(err || '');
    return ERROR_MESSAGES[raw] || raw || 'Ocorreu um erro inesperado. Tente novamente.';
  }

  async function signUp({ email, password, name, companyName, phone }) {
    if (!client()) throw new Error('Supabase não está configurado neste ambiente.');
    const { data, error } = await client().auth.signUp({
      email,
      password,
      options: {
        data: { name, company_name: companyName, phone },
      },
    });
    if (error) throw new Error(friendlyError(error));
    return data;
  }

  async function signIn({ email, password }) {
    if (!client()) throw new Error('Supabase não está configurado neste ambiente.');
    const { data, error } = await client().auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendlyError(error));
    return data;
  }

  async function signOut() {
    if (!client()) return;
    await client().auth.signOut();
  }

  async function resetPassword(email) {
    if (!client()) throw new Error('Supabase não está configurado neste ambiente.');
    const redirectTo = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}login.html`;
    const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new Error(friendlyError(error));
  }

  async function getSession() {
    if (!client()) return null;
    const { data } = await client().auth.getSession();
    return data?.session || null;
  }

  function currentPageFile() {
    return window.location.pathname.split('/').pop() || 'index.html';
  }

  // Chamada no topo de cada página privada. Retorna a sessão (ou um objeto
  // "demo" quando useDemoMode) e redireciona para login.html quando não
  // houver sessão válida em modo real.
  async function requireSession() {
    if (cfg.useDemoMode) {
      return { demo: true, user: { email: 'demo@smartbilling.local' } };
    }
    const session = await getSession();
    if (!session) {
      const next = encodeURIComponent(currentPageFile());
      window.location.replace(`login.html?redirect=${next}`);
      return null;
    }
    return session;
  }

  // Chamada no topo de login.html: se já houver sessão válida, manda para o painel.
  async function redirectIfAuthenticated() {
    if (cfg.useDemoMode) return false;
    const session = await getSession();
    if (session) {
      const params = new URLSearchParams(window.location.search);
      window.location.replace(params.get('redirect') || 'index.html');
      return true;
    }
    return false;
  }

  return {
    signUp, signIn, signOut, resetPassword, getSession,
    requireSession, redirectIfAuthenticated, friendlyError,
  };
})();
