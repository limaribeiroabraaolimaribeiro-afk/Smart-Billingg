/* ==========================================================================
   Smart Billing — Planos (listing) page logic
   ========================================================================== */

(async function initPlanos() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  await SBLayout.mount({
    active: 'planos',
    title: 'Planos',
    breadcrumb: 'Painel <span>/</span> Planos',
    hidePrimaryAction: true,
  });

  let all = [];
  const listRegion = document.getElementById('list-region');

  const TIPO_LABEL = { one_time: 'Pagamento único', recurring_monthly: 'Recorrente' };

  function moneyPerMonth(plano) {
    if (plano.tipoCobranca === 'recurring_monthly') return null;
    if (!plano.duracaoMeses || plano.duracaoMeses <= 1) return null;
    return plano.valor / plano.duracaoMeses;
  }

  function cardHtml(p) {
    const equivalente = moneyPerMonth(p);
    const economia = p.valorReferencia != null ? p.valorReferencia - p.valor : null;
    const menuId = `plano-${p.id}`;
    return `
      <div class="plan-card ${p.destaque ? 'plan-card--featured' : ''} ${p.ativo ? '' : 'plan-card--inactive'}">
        ${p.badge ? `<span class="plan-card__badge">${SB_UI.escapeHtml(p.badge)}</span>` : ''}
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="badge ${p.ativo ? 'badge-paid' : 'badge-canceled'}">${p.ativo ? 'Ativo' : 'Inativo'}</span>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${menuId}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${menuId}">
              <a class="action-menu__item" href="plano-form.html?id=${p.id}">${SB_ICON.edit}<span>Editar</span></a>
              <button class="action-menu__item" data-act="duplicate" data-id="${p.id}">${SB_ICON.copy}<span>Duplicar</span></button>
              <button class="action-menu__item" data-act="toggle" data-id="${p.id}" data-ativo="${p.ativo}">${p.ativo ? SB_ICON.ban : SB_ICON.checkCircle}<span>${p.ativo ? 'Desativar' : 'Ativar'}</span></button>
              <a class="action-menu__item" href="clientes.html">${SB_ICON.link}<span>Criar oferta</span></a>
              <div class="action-menu__divider"></div>
              <button class="action-menu__item is-danger" data-act="delete" data-id="${p.id}">${SB_ICON.ban}<span>Excluir plano</span></button>
            </div>
          </div>
        </div>
        <div class="plan-card__name">${SB_UI.escapeHtml(p.nome)}</div>
        ${p.descontoPercent > 0 ? `<div class="plan-card__discount">${p.descontoPercent}% OFF</div>` : ''}
        ${p.valorReferencia != null ? `<div class="plan-card__reference">${SB_UI.formatCurrency(p.valorReferencia)}</div>` : ''}
        <div class="plan-card__price">${SB_UI.formatCurrency(p.valor)}${p.tipoCobranca === 'recurring_monthly' ? '<span>/mês</span>' : ''}</div>
        ${equivalente != null ? `<div class="plan-card__equivalent">equivale a ${SB_UI.formatCurrency(equivalente)}/mês</div>` : ''}
        ${economia != null && economia > 0 ? `<div class="plan-card__savings">Economize ${SB_UI.formatCurrency(economia)}</div>` : ''}
        ${p.descricaoCurta ? `<div class="plan-card__desc">${SB_UI.escapeHtml(p.descricaoCurta)}</div>` : ''}
        <div class="plan-card__meta">
          <span>${TIPO_LABEL[p.tipoCobranca] || p.tipoCobranca} · ${p.duracaoMeses} ${p.duracaoMeses === 1 ? 'mês' : 'meses'}</span>
          <span>${p.clientesAtivos || 0} ${p.clientesAtivos === 1 ? 'cliente' : 'clientes'}</span>
        </div>
      </div>`;
  }

  function render() {
    if (all.length === 0) {
      listRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.package}</div>
          <div class="state-block__title">Nenhum plano cadastrado</div>
          <p class="state-block__desc">Crie planos como Mensal, Anual ou 2 anos para oferecer aos seus clientes.</p>
          <a href="plano-form.html" class="btn btn-primary btn-sm">${SB_ICON.plus}<span>Novo plano</span></a>
        </div>`;
      return;
    }
    listRegion.innerHTML = `<div class="plan-grid">${all.map(cardHtml).join('')}</div>`;
    SB_UI.initActionMenus(listRegion);
  }

  listRegion.addEventListener('click', async (e) => {
    const dupBtn = e.target.closest('[data-act="duplicate"]');
    const toggleBtn = e.target.closest('[data-act="toggle"]');
    const delBtn = e.target.closest('[data-act="delete"]');

    if (dupBtn) {
      await DB.planos.duplicate(dupBtn.dataset.id);
      SB_UI.toast({ type: 'success', title: 'Plano duplicado', desc: 'A cópia foi criada inativa — revise e ative quando quiser.' });
      load();
      return;
    }

    if (toggleBtn) {
      const ativo = toggleBtn.dataset.ativo === 'true';
      await DB.planos.update(toggleBtn.dataset.id, { ativo: !ativo });
      SB_UI.toast({ type: 'success', title: ativo ? 'Plano desativado' : 'Plano ativado' });
      load();
      return;
    }

    if (delBtn) {
      const plano = all.find((p) => p.id === delBtn.dataset.id);
      if (!plano) return;
      const ok = await SB_UI.confirmDialog({
        title: `Excluir "${plano.nome}"?`,
        desc: 'Esta ação não pode ser desfeita. Se houver clientes com assinatura ativa neste plano, a exclusão será bloqueada — desative o plano nesse caso.',
        confirmLabel: 'Excluir plano',
        cancelLabel: 'Cancelar',
        tone: 'danger',
      });
      if (!ok) return;
      const result = await DB.planos.remove(plano.id);
      if (result && result.success === false) {
        SB_UI.toast({ type: 'error', title: 'Não foi possível excluir', desc: result.message });
        return;
      }
      SB_UI.toast({ type: 'success', title: 'Plano excluído' });
      load();
    }
  });

  async function load() {
    try {
      all = await DB.planos.listWithStats();
      render();
    } catch (err) {
      listRegion.innerHTML = `
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Não foi possível carregar os planos</div>
          <p class="state-block__desc">Ocorreu um erro ao buscar os dados. Tente novamente.</p>
          <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
        </div>`;
    }
  }

  load();
})();
