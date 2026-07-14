/* ==========================================================================
   Smart Billing — Configurações page logic
   ========================================================================== */

(async function initConfiguracoes() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

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
          ${fieldRow('Cargo', empresa.admin.cargo).replace('<input', `<input id="perfil-cargo" ${window.SMART_BILLING_CONFIG?.useDemoMode ? '' : 'disabled title="O cargo é definido pela sua função na empresa e não pode ser editado aqui."'}`)}
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

  function sectionDados() {
    const isDemo = Boolean(window.SMART_BILLING_CONFIG?.useDemoMode);
    const snapshot = DB._readLocalDemoSnapshot?.();
    const qtdClientes = snapshot?.clientes?.length || 0;
    const qtdCobrancas = snapshot?.cobrancas?.length || 0;
    const jaMigrado = localStorage.getItem('smart_billing_migration_done_v1');

    if (isDemo) {
      return `
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Migração de dados</div>
          <div class="card-header__subtitle" style="margin-bottom:16px;">Disponível somente quando o Supabase estiver configurado</div>
          <div class="auth-banner">
            ${SB_ICON.alertTriangle}
            <span>O sistema está em <strong>modo de demonstração</strong>. Configure o Supabase (veja SUPABASE_SETUP.md) para habilitar a migração dos dados simulados para o banco real.</span>
          </div>
        </div>`;
    }

    if (qtdClientes === 0 && qtdCobrancas === 0) {
      return `
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Migração de dados</div>
          <div class="card-header__subtitle" style="margin-bottom:16px;">Transferir dados simulados (localStorage) para o Supabase</div>
          <div class="state-block">
            <div class="state-block__icon">${SB_ICON.inbox}</div>
            <div class="state-block__title">Nenhum dado local encontrado</div>
            <p class="state-block__desc">Não há clientes ou cobranças de demonstração salvos neste navegador para migrar.</p>
          </div>
        </div>`;
    }

    return `
      <div class="card card-pad">
        <div class="card-header__title" style="margin-bottom:4px;">Migração de dados</div>
        <div class="card-header__subtitle" style="margin-bottom:16px;">Transferir os dados simulados deste navegador (localStorage) para o Supabase</div>

        ${jaMigrado ? `
          <div class="auth-banner">
            ${SB_ICON.alertTriangle}
            <span>Uma migração já foi realizada neste navegador em <strong>${SB_UI.formatDateTime(jaMigrado)}</strong>. Rodar novamente pode duplicar registros.</span>
          </div>` : ''}

        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
          <div class="summary-row"><span class="label">Clientes encontrados</span><span class="value">${qtdClientes}</span></div>
          <div class="summary-row"><span class="label">Cobranças encontradas</span><span class="value">${qtdCobrancas}</span></div>
        </div>

        <p class="field-hint" style="margin-bottom:16px;">
          Os clientes serão criados primeiro; em seguida as cobranças serão recriadas já vinculadas ao cliente correto.
          Cobranças que estavam pagas geram automaticamente um pagamento e um recibo (com data/hora da migração).
          Os dados locais NÃO são apagados — permanecem como backup neste navegador.
        </p>

        <button class="btn btn-primary" id="btn-start-migration">
          ${SB_ICON.package}<span>${jaMigrado ? 'Migrar novamente mesmo assim' : 'Iniciar migração'}</span>
        </button>
        <div id="migration-result" style="margin-top:16px;"></div>
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
    dados: sectionDados,
  };

  async function runMigration() {
    const snapshot = DB._readLocalDemoSnapshot();
    const resultEl = document.getElementById('migration-result');
    const btn = document.getElementById('btn-start-migration');

    const ok = await SB_UI.confirmDialog({
      title: 'Iniciar migração de dados',
      desc: `Isso vai criar ${snapshot.clientes.length} cliente(s) e ${snapshot.cobrancas.length} cobrança(s) no Supabase, vinculados à sua empresa atual. Deseja continuar?`,
      confirmLabel: 'Migrar agora',
      tone: 'warn',
    });
    if (!ok) return;

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Migrando...';

    const idMap = {};
    let clientesOk = 0;
    let cobrancasOk = 0;
    let cobrancasPagas = 0;
    let cobrancasCanceladas = 0;
    const erros = [];

    for (const cli of snapshot.clientes) {
      try {
        const novo = await DB.clientes.create({ nome: cli.nome, whatsapp: cli.whatsapp, email: cli.email });
        idMap[cli.id] = novo.id;
        clientesOk += 1;
      } catch (err) {
        erros.push(`Cliente "${cli.nome}": ${err.message}`);
      }
    }

    for (const cob of snapshot.cobrancas) {
      const novoClienteId = idMap[cob.clienteId];
      if (!novoClienteId) {
        erros.push(`Cobrança "${cob.descricao}" ignorada (cliente original não encontrado).`);
        continue;
      }
      try {
        const nova = await DB.cobrancas.create({
          clienteId: novoClienteId,
          descricao: cob.descricao,
          valor: cob.valor,
          vencimento: cob.vencimento,
          formaPagamento: cob.formaPagamento,
          parcelas: cob.parcelas,
          observacoes: cob.observacoes || '',
          enviarWhatsapp: false,
          enviarEmail: false,
        });
        cobrancasOk += 1;

        if (cob.status === 'pago') {
          await DB.cobrancas.markPaid(nova.id, { forma: cob.formaPagamento === 'ambos' ? 'pix' : cob.formaPagamento, parcelas: cob.parcelas });
          cobrancasPagas += 1;
        } else if (cob.status === 'cancelado') {
          await DB.cobrancas.cancel(nova.id);
          cobrancasCanceladas += 1;
        }
      } catch (err) {
        erros.push(`Cobrança "${cob.descricao}": ${err.message}`);
      }
    }

    localStorage.setItem('smart_billing_migration_done_v1', new Date().toISOString());

    resultEl.innerHTML = `
      <div class="auth-banner" style="background:var(--green-100);border-color:rgba(16,185,129,.3);">
        ${SB_ICON.checkCircle}
        <span>
          Migração concluída: <strong>${clientesOk}</strong> cliente(s) e <strong>${cobrancasOk}</strong> cobrança(s) criados
          (${cobrancasPagas} marcada(s) como paga, ${cobrancasCanceladas} cancelada(s)).
          ${erros.length ? `${erros.length} item(ns) com erro — veja abaixo.` : ''}
        </span>
      </div>
      ${erros.length ? `<ul style="margin-top:10px;padding-left:18px;font-size:12px;color:var(--red-600,#dc2626);">${erros.map((e) => `<li>${SB_UI.escapeHtml(e)}</li>`).join('')}</ul>` : ''}
    `;
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Migrar novamente mesmo assim';
    SB_UI.toast({ type: 'success', title: 'Migração concluída', desc: `${clientesOk} clientes, ${cobrancasOk} cobranças.` });
  }

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
      document.getElementById('btn-change-pass')?.addEventListener('click', async () => {
        if (window.SMART_BILLING_CONFIG?.useDemoMode) {
          SB_UI.toast({ type: 'info', title: 'Indisponível no modo demonstração', desc: 'Conecte a autenticação do Supabase para habilitar esta ação.' });
          return;
        }
        try {
          await SB_AUTH.resetPassword(empresa.admin.email);
          SB_UI.toast({ type: 'success', title: 'E-mail enviado', desc: `Link para redefinir a senha enviado para ${empresa.admin.email}.` });
        } catch (err) {
          SB_UI.toast({ type: 'error', title: 'Não foi possível enviar o e-mail', desc: err.message });
        }
      });
      document.getElementById('btn-logout-all')?.addEventListener('click', async () => {
        const ok = await SB_UI.confirmDialog({
          title: 'Sair de todos os dispositivos',
          desc: 'Isso encerrará todas as sessões ativas, incluindo a atual. Deseja continuar?',
          confirmLabel: 'Sair de todos',
          tone: 'danger',
        });
        if (ok) {
          await SB_AUTH?.signOut();
          SB_UI.toast({ type: 'info', title: 'Sessões encerradas' });
          const dest = window.SMART_BILLING_CONFIG?.useDemoMode ? 'index.html' : 'login.html';
          setTimeout(() => { window.location.href = dest; }, 600);
        }
      });
    }
    if (name === 'dados') {
      document.getElementById('btn-start-migration')?.addEventListener('click', runMigration);
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
