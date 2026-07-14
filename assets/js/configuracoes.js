/* ==========================================================================
   Smart Billing — Configurações page logic
   ========================================================================== */

(async function initConfiguracoes() {
  await SBLayout.mount({
    active: 'configuracoes',
    title: 'Configurações',
    breadcrumb: 'Painel <span>/</span> Configurações',
    hidePrimaryAction: true,
  });

  const content = document.getElementById('settings-content');
  const menu = document.getElementById('settings-menu');
  let empresa = null;

  try {
    empresa = await DB.empresa.get();
  } catch (err) {
    empresa = null;
  }

  function fieldRow(label, value) {
    return `<div class="field"><label>${label}</label><input class="input" value="${SB_UI.escapeHtml(value || '')}" /></div>`;
  }

  function sectionPerfil() {
    if (!empresa) return errorBlock();
    return `
      <form class="card card-pad" id="form-perfil">
        <div class="card-header__title" style="margin-bottom:4px;">Perfil do administrador</div>
        <div class="card-header__subtitle" style="margin-bottom:20px;">Suas informações pessoais de acesso</div>
        <div class="field-row">
          ${fieldRow('Nome completo', empresa.admin.nome).replace('<input', '<input id="perfil-nome"')}
          ${fieldRow('Cargo', empresa.admin.cargo).replace('<input', '<input id="perfil-cargo"')}
        </div>
        <div class="field" style="margin-top:16px;">
          <label>E-mail de acesso</label>
          <input class="input" id="perfil-email" type="email" value="${SB_UI.escapeHtml(empresa.admin.email)}" />
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:20px;">Salvar alterações</button>
      </form>`;
  }

  function sectionEmpresa() {
    if (!empresa) return errorBlock();
    return `
      <form class="card card-pad" id="form-empresa">
        <div class="card-header__title" style="margin-bottom:4px;">Dados da empresa</div>
        <div class="card-header__subtitle" style="margin-bottom:20px;">Essas informações aparecem nas cobranças e recibos enviados aos clientes</div>
        <div class="field">
          <label>Razão social</label>
          <input class="input" id="empresa-nome" value="${SB_UI.escapeHtml(empresa.nome)}" />
        </div>
        <div class="field-row" style="margin-top:16px;">
          <div class="field"><label>CNPJ</label><input class="input" id="empresa-cnpj" value="${SB_UI.escapeHtml(empresa.cnpj)}" /></div>
          <div class="field"><label>Telefone</label><input class="input" id="empresa-telefone" value="${SB_UI.escapeHtml(empresa.telefone)}" /></div>
        </div>
        <div class="field" style="margin-top:16px;">
          <label>E-mail financeiro</label>
          <input class="input" id="empresa-email" type="email" value="${SB_UI.escapeHtml(empresa.email)}" />
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:20px;">Salvar alterações</button>
      </form>`;
  }

  function integrationCard({ title, desc, icon, configured, fields }) {
    return `
      <div class="card card-pad">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;">
          <div style="display:flex;gap:12px;align-items:center;">
            <span class="stat-card__icon stat-card__icon--brand" style="width:38px;height:38px;">${icon}</span>
            <div>
              <div class="card-header__title" style="font-size:14px;">${title}</div>
              <div class="card-header__subtitle">${desc}</div>
            </div>
          </div>
          <span class="badge ${configured ? 'badge-paid' : 'badge-pending'}">${configured ? 'Configurado' : 'Não configurado'}</span>
        </div>
        ${fields}
      </div>`;
  }

  function sectionIntegracoes() {
    const cfg = window.SMART_BILLING_CONFIG || {};
    return `
      <div style="display:flex;flex-direction:column;gap:20px;">
        ${integrationCard({
          title: 'Supabase',
          desc: 'Banco de dados e autenticação',
          icon: SB_ICON.package,
          configured: Boolean(cfg.supabase?.url),
          fields: `
            <div class="field-row">
              <div class="field"><label>URL do projeto</label><input class="input" placeholder="https://xxxx.supabase.co" value="${SB_UI.escapeHtml(cfg.supabase?.url || '')}" disabled /></div>
              <div class="field"><label>Chave anônima (anon key)</label><input class="input" type="password" placeholder="••••••••••••••••" disabled /></div>
            </div>
            <p class="field-hint" style="margin-top:10px;">As credenciais devem ser definidas por variáveis de ambiente no ambiente de produção — nunca diretamente no código-fonte.</p>`,
        })}
        ${integrationCard({
          title: 'InfinitePay',
          desc: 'Processamento de pagamentos via Pix e cartão',
          icon: SB_ICON.card,
          configured: Boolean(cfg.infinitePay?.clientId),
          fields: `
            <div class="field-row">
              <div class="field"><label>Client ID</label><input class="input" placeholder="ip_client_xxxxxxxx" value="${SB_UI.escapeHtml(cfg.infinitePay?.clientId || '')}" disabled /></div>
              <div class="field"><label>Ambiente</label><select class="select" disabled><option>Produção</option><option>Sandbox</option></select></div>
            </div>
            <p class="field-hint" style="margin-top:10px;">A chave secreta de API nunca deve ser exposta no front-end — todas as chamadas autenticadas devem passar por uma function de backend.</p>`,
        })}
      </div>`;
  }

  function sectionNotificacoes() {
    const prefs = JSON.parse(localStorage.getItem('sb_notif_prefs') || '{}');
    const opt = (key, def) => prefs[key] !== undefined ? prefs[key] : def;
    return `
      <div class="card card-pad">
        <div class="card-header__title" style="margin-bottom:4px;">Preferências de notificação</div>
        <div class="card-header__subtitle" style="margin-bottom:20px;">Escolha como deseja ser avisado sobre eventos de cobrança</div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <label class="checkbox-row"><input type="checkbox" data-pref="pagamento" ${opt('pagamento', true) ? 'checked' : ''} /><span><span class="checkbox-row__label">Pagamento recebido</span><br/><span class="checkbox-row__desc">Ser notificado quando uma cobrança for paga</span></span></label>
          <label class="checkbox-row"><input type="checkbox" data-pref="vencimento" ${opt('vencimento', true) ? 'checked' : ''} /><span><span class="checkbox-row__label">Cobrança vencendo</span><br/><span class="checkbox-row__desc">Alertar 3 dias antes do vencimento</span></span></label>
          <label class="checkbox-row"><input type="checkbox" data-pref="atraso" ${opt('atraso', true) ? 'checked' : ''} /><span><span class="checkbox-row__label">Cobrança atrasada</span><br/><span class="checkbox-row__desc">Ser notificado quando uma cobrança vencer sem pagamento</span></span></label>
        </div>
      </div>`;
  }

  function sectionSeguranca() {
    return `
      <div style="display:flex;flex-direction:column;gap:20px;">
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Senha de acesso</div>
          <div class="card-header__subtitle" style="margin-bottom:20px;">Recomendamos alterar sua senha periodicamente</div>
          <button class="btn btn-secondary" id="btn-change-pass">${SB_ICON.key}<span>Alterar senha</span></button>
        </div>
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;color:var(--red-500);">Zona de risco</div>
          <div class="card-header__subtitle" style="margin-bottom:20px;">Ações irreversíveis relacionadas à sua conta</div>
          <button class="btn btn-danger-ghost" id="btn-logout-all">${SB_ICON.logout}<span>Sair de todos os dispositivos</span></button>
        </div>
      </div>`;
  }

  function errorBlock() {
    return `
      <div class="card card-pad">
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Não foi possível carregar os dados</div>
          <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
        </div>
      </div>`;
  }

  const sections = {
    perfil: sectionPerfil,
    empresa: sectionEmpresa,
    integracoes: sectionIntegracoes,
    notificacoes: sectionNotificacoes,
    seguranca: sectionSeguranca,
  };

  function wireSection(name) {
    if (name === 'perfil') {
      document.getElementById('form-perfil')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const admin = {
          nome: document.getElementById('perfil-nome').value.trim(),
          cargo: document.getElementById('perfil-cargo').value.trim(),
          email: document.getElementById('perfil-email').value.trim(),
        };
        await DB.empresa.update({ admin: { ...empresa.admin, ...admin } });
        empresa.admin = { ...empresa.admin, ...admin };
        SB_UI.toast({ type: 'success', title: 'Perfil atualizado com sucesso' });
      });
    }
    if (name === 'empresa') {
      document.getElementById('form-empresa')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          nome: document.getElementById('empresa-nome').value.trim(),
          cnpj: document.getElementById('empresa-cnpj').value.trim(),
          telefone: document.getElementById('empresa-telefone').value.trim(),
          email: document.getElementById('empresa-email').value.trim(),
        };
        await DB.empresa.update(payload);
        empresa = { ...empresa, ...payload };
        SB_UI.toast({ type: 'success', title: 'Dados da empresa atualizados' });
      });
    }
    if (name === 'notificacoes') {
      content.querySelectorAll('[data-pref]').forEach((el) => {
        el.addEventListener('change', () => {
          const prefs = JSON.parse(localStorage.getItem('sb_notif_prefs') || '{}');
          prefs[el.dataset.pref] = el.checked;
          localStorage.setItem('sb_notif_prefs', JSON.stringify(prefs));
          SB_UI.toast({ type: 'success', title: 'Preferência salva', duration: 2000 });
        });
      });
    }
    if (name === 'seguranca') {
      document.getElementById('btn-change-pass')?.addEventListener('click', () => {
        SB_UI.toast({ type: 'info', title: 'Indisponível no modo demonstração', desc: 'Conecte a autenticação do Supabase para habilitar esta ação.' });
      });
      document.getElementById('btn-logout-all')?.addEventListener('click', async () => {
        const ok = await SB_UI.confirmDialog({
          title: 'Sair de todos os dispositivos',
          desc: 'Isso encerrará todas as sessões ativas, incluindo a atual. Deseja continuar?',
          confirmLabel: 'Sair de todos',
          tone: 'danger',
        });
        if (ok) {
          SB_UI.toast({ type: 'info', title: 'Sessões encerradas' });
          setTimeout(() => { window.location.href = 'index.html'; }, 600);
        }
      });
    }
  }

  function render(name) {
    content.innerHTML = sections[name] ? sections[name]() : errorBlock();
    wireSection(name);
  }

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-section]');
    if (!btn) return;
    menu.querySelectorAll('.settings-menu-item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    render(btn.dataset.section);
  });

  render('perfil');
})();
