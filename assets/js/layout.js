/* ==========================================================================
   Smart Billing — App shell (sidebar + topbar) renderer
   ========================================================================== */

const SB_NAV = [
  { key: 'dashboard', label: 'Dashboard', href: 'index.html', icon: SB_ICON.dashboard },
  { key: 'cobrancas', label: 'Cobranças', href: 'cobrancas.html', icon: SB_ICON.invoice },
  { key: 'clientes', label: 'Clientes', href: 'clientes.html', icon: SB_ICON.users },
  { key: 'pagamentos', label: 'Pagamentos', href: 'pagamentos.html', icon: SB_ICON.card },
  { key: 'recibos', label: 'Recibos', href: 'recibos.html', icon: SB_ICON.receipt },
  { key: 'relatorios', label: 'Relatórios', href: 'relatorios.html', icon: SB_ICON.chart },
  { key: 'configuracoes', label: 'Configurações', href: 'configuracoes.html', icon: SB_ICON.settings },
];

const SBLayout = (() => {
  function sidebarHtml(active) {
    const links = SB_NAV.map((item) => `
      <a class="sidebar-link${item.key === active ? ' is-active' : ''}" href="${item.href}">
        <span class="sidebar-link__icon">${item.icon}</span>
        <span>${item.label}</span>
      </a>`).join('');

    return `
      <aside class="sidebar" id="sb-sidebar">
        <div class="sidebar-brand">
          <img class="sidebar-brand__wordmark" src="assets/img/logo.png" alt="Smart Billing" />
          <button class="topbar-menu-btn sidebar-close" id="sb-sidebar-close" aria-label="Fechar menu" style="margin-left:auto;color:rgba(255,255,255,.7)">${SB_ICON.close}</button>
        </div>
        <div class="sidebar-tagline">Cobranças &amp; Pagamentos</div>
        <nav class="sidebar-nav" aria-label="Navegação principal">${links}</nav>
        <div class="sidebar-footer">
          <button class="sidebar-logout" id="sb-logout-btn" type="button">
            <span class="sidebar-link__icon">${SB_ICON.logout}</span>
            <span>Sair da conta</span>
          </button>
        </div>
      </aside>
      <div class="sidebar-overlay" id="sb-sidebar-overlay"></div>`;
  }

  function topbarHtml(opts) {
    const primary = opts.hidePrimaryAction ? '' : `
      <a href="cobranca-form.html" class="btn btn-primary">
        ${SB_ICON.plus}<span>Criar cobrança</span>
      </a>`;

    return `
      <header class="topbar">
        <div class="topbar-left">
          <button class="topbar-menu-btn" id="sb-menu-btn" aria-label="Abrir menu">${SB_ICON.menu}</button>
          <div class="topbar-title-group">
            <h1 class="topbar-title">${opts.title || ''}</h1>
            ${opts.breadcrumb ? `<div class="topbar-breadcrumb">${opts.breadcrumb}</div>` : ''}
          </div>
        </div>
        <div class="topbar-right">
          ${primary}
          <div style="position:relative">
            <button class="icon-btn" id="sb-notif-btn" aria-label="Notificações">
              ${SB_ICON.bell}<span class="icon-btn__dot"></span>
            </button>
            <div class="action-menu" id="sb-notif-menu" style="min-width:300px;right:0;">
              <div style="padding:8px 10px;font-size:12.5px;font-weight:800;color:var(--text-primary);">Notificações</div>
              ${SB_NOTIFICATIONS.map((n) => `
                <div class="action-menu__item" style="align-items:flex-start;cursor:default;">
                  <span style="width:8px;height:8px;border-radius:50%;margin-top:5px;flex-shrink:0;background:${n.tone === 'success' ? 'var(--green-500)' : n.tone === 'warn' ? 'var(--amber-500)' : 'var(--red-500)'}"></span>
                  <span style="display:flex;flex-direction:column;gap:2px;">
                    <span style="font-weight:700;color:var(--text-primary);">${n.title}</span>
                    <span style="font-size:11.5px;color:var(--text-muted);font-weight:500;">${n.desc}</span>
                    <span style="font-size:10.5px;color:var(--text-muted);">${n.time}</span>
                  </span>
                </div>`).join('<div class="action-menu__divider"></div>')}
            </div>
          </div>
          <div style="position:relative">
            <button class="topbar-user" id="sb-user-btn">
              <span class="avatar" id="sb-user-avatar">--</span>
              <span class="topbar-user__meta">
                <span class="topbar-user__name" id="sb-user-name">Carregando…</span>
                <span class="topbar-user__role">Administrador</span>
              </span>
              <span class="topbar-user__caret">${SB_ICON.chevronDown}</span>
            </button>
            <div class="action-menu" id="sb-user-menu" style="min-width:190px;right:0;">
              <a class="action-menu__item" href="configuracoes.html">${SB_ICON.settings}<span>Configurações</span></a>
              <div class="action-menu__divider"></div>
              <button class="action-menu__item is-danger" id="sb-user-logout" type="button">${SB_ICON.logout}<span>Sair da conta</span></button>
            </div>
          </div>
        </div>
      </header>`;
  }

  function demoBannerHtml() {
    if (!window.SMART_BILLING_CONFIG?.useDemoMode) return '';
    return `
      <div class="demo-banner">
        ${SB_ICON.alertTriangle}
        <span>Modo de demonstração — os dados exibidos são simulados e não usam o Supabase. <a href="configuracoes.html">Configure a integração</a> para usar dados reais.</span>
      </div>`;
  }

  async function mount(opts = {}) {
    const contentHost = document.getElementById('page-content');
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.innerHTML = `
      ${sidebarHtml(opts.active)}
      <div class="app-main">
        ${topbarHtml(opts)}
        ${demoBannerHtml()}
        <main class="app-content" id="sb-app-content"></main>
      </div>`;

    document.body.insertBefore(shell, document.body.firstChild);

    const appContent = shell.querySelector('#sb-app-content');
    if (contentHost) {
      while (contentHost.firstChild) appContent.appendChild(contentHost.firstChild);
      contentHost.remove();
    }

    wireInteractions();
    loadUser();
    document.title = opts.title ? `${opts.title} · Smart Billing` : 'Smart Billing';
  }

  function wireInteractions() {
    const sidebar = document.getElementById('sb-sidebar');
    const overlay = document.getElementById('sb-sidebar-overlay');
    const menuBtn = document.getElementById('sb-menu-btn');
    const closeBtn = document.getElementById('sb-sidebar-close');

    const openSidebar = () => { sidebar.classList.add('is-open'); overlay.style.display = 'block'; document.body.style.overflow = 'hidden'; };
    const closeSidebar = () => { sidebar.classList.remove('is-open'); overlay.style.display = 'none'; document.body.style.overflow = ''; };

    menuBtn?.addEventListener('click', openSidebar);
    closeBtn?.addEventListener('click', closeSidebar);
    overlay?.addEventListener('click', closeSidebar);
    sidebar.querySelectorAll('.sidebar-link').forEach((a) => a.addEventListener('click', closeSidebar));

    // Notification dropdown
    setupDropdown('sb-notif-btn', 'sb-notif-menu');
    setupDropdown('sb-user-btn', 'sb-user-menu');

    const doLogout = async () => {
      const ok = await SB_UI.confirmDialog({
        title: 'Sair da conta',
        desc: 'Você será desconectado do Smart Billing. Deseja continuar?',
        confirmLabel: 'Sair',
        tone: 'danger',
      });
      if (ok) {
        await SB_AUTH?.signOut();
        SB_UI.toast({ type: 'info', title: 'Sessão encerrada', desc: 'Até logo!' });
        const dest = window.SMART_BILLING_CONFIG?.useDemoMode ? 'index.html' : 'login.html';
        setTimeout(() => { window.location.href = dest; }, 600);
      }
    };
    document.getElementById('sb-logout-btn')?.addEventListener('click', doLogout);
    document.getElementById('sb-user-logout')?.addEventListener('click', doLogout);
  }

  function setupDropdown(btnId, menuId) {
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('is-open');
      document.querySelectorAll('.action-menu.is-open').forEach((m) => m.classList.remove('is-open'));
      if (willOpen) menu.classList.add('is-open');
    });
    document.addEventListener('click', () => menu.classList.remove('is-open'));
  }

  async function loadUser() {
    try {
      const empresa = await DB.empresa.get();
      const nameEl = document.getElementById('sb-user-name');
      const avatarEl = document.getElementById('sb-user-avatar');
      if (nameEl) nameEl.textContent = empresa.admin.nome;
      if (avatarEl) avatarEl.textContent = SB_UI.initials(empresa.admin.nome);
    } catch (e) {
      const nameEl = document.getElementById('sb-user-name');
      if (nameEl) nameEl.textContent = 'Administrador';
    }
  }

  return { mount };
})();
