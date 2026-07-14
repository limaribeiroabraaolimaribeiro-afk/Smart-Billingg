/* ==========================================================================
   Smart Billing — Lógica da página de login
   ========================================================================== */

(async function initLogin() {
  const cfg = window.SMART_BILLING_CONFIG || {};
  const alertSlot = document.getElementById('auth-alert-slot');
  const bannerSlot = document.getElementById('demo-banner-slot');

  function showAlert(message) {
    alertSlot.innerHTML = `
      <div class="auth-alert">
        ${SB_ICON.alertCircle}
        <span>${SB_UI.escapeHtml(message)}</span>
      </div>`;
  }
  function clearAlert() { alertSlot.innerHTML = ''; }

  // ---------------- Modo demonstração ----------------
  if (cfg.useDemoMode) {
    bannerSlot.innerHTML = `
      <div class="auth-banner">
        ${SB_ICON.alertTriangle}
        <span><strong>Modo de demonstração ativo.</strong> O Supabase ainda não foi configurado (veja SUPABASE_SETUP.md). Você pode explorar o sistema com dados simulados, sem precisar criar uma conta.</span>
      </div>`;

    document.getElementById('auth-forms').innerHTML = `
      <div class="auth-title">Modo de demonstração</div>
      <p class="auth-subtitle">Configure o Supabase para habilitar login real, cadastro e persistência de dados.</p>
      <a href="index.html" class="btn btn-primary btn-block" style="margin-top:24px;">
        <span>Entrar no painel de demonstração</span>
      </a>`;
    return;
  }

  // Se já houver sessão válida, vai direto para o painel.
  const alreadyIn = await SB_AUTH.redirectIfAuthenticated();
  if (alreadyIn) return;

  // ---------------- Tabs ----------------
  const tabs = document.getElementById('auth-tabs');
  function activateTab(name) {
    clearAlert();
    tabs.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
    document.querySelectorAll('.auth-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  }
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) activateTab(btn.dataset.tab);
  });
  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.goto));
  });

  // ---------------- Mostrar/ocultar senha ----------------
  document.querySelectorAll('.password-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.toggleFor);
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      btn.setAttribute('aria-label', isHidden ? 'Ocultar senha' : 'Mostrar senha');
    });
  });

  function setLoading(button, loading, label) {
    button.disabled = loading;
    button.querySelector('span').textContent = loading ? 'Aguarde...' : label;
  }

  // ---------------- Login ----------------
  document.getElementById('panel-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert();
    const btn = document.getElementById('login-submit');
    setLoading(btn, true, 'Entrar');
    try {
      await SB_AUTH.signIn({
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value,
      });
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get('redirect') || 'index.html';
    } catch (err) {
      showAlert(err.message);
      setLoading(btn, false, 'Entrar');
    }
  });

  // ---------------- Cadastro ----------------
  document.getElementById('panel-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert();
    const btn = document.getElementById('signup-submit');
    setLoading(btn, true, 'Criar conta');
    try {
      const password = document.getElementById('signup-password').value;
      if (password.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres.');

      await SB_AUTH.signUp({
        name: document.getElementById('signup-name').value.trim(),
        companyName: document.getElementById('signup-company').value.trim(),
        phone: document.getElementById('signup-phone').value.trim(),
        email: document.getElementById('signup-email').value.trim(),
        password,
      });
      SB_UI.toast({ type: 'success', title: 'Conta criada com sucesso', desc: 'Você já pode acessar o painel.' });
      setTimeout(() => { window.location.href = 'index.html'; }, 800);
    } catch (err) {
      showAlert(err.message);
      setLoading(btn, false, 'Criar conta');
    }
  });

  // ---------------- Esqueci a senha ----------------
  document.getElementById('panel-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert();
    const btn = document.getElementById('forgot-submit');
    setLoading(btn, true, 'Enviar link de redefinição');
    try {
      await SB_AUTH.resetPassword(document.getElementById('forgot-email').value.trim());
      SB_UI.toast({ type: 'success', title: 'E-mail enviado', desc: 'Confira sua caixa de entrada para redefinir a senha.' });
      setLoading(btn, false, 'Enviar link de redefinição');
    } catch (err) {
      showAlert(err.message);
      setLoading(btn, false, 'Enviar link de redefinição');
    }
  });
})();
