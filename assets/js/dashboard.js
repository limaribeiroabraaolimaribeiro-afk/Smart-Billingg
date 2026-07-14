/* ==========================================================================
   Smart Billing — Dashboard page logic
   ========================================================================== */

(async function initDashboard() {
  await SBLayout.mount({
    active: 'dashboard',
    title: 'Dashboard',
    breadcrumb: 'Painel <span>/</span> Dashboard',
  });

  let allRecent = [];
  const state = { search: '', status: '', date: '' };

  const tableRegion = document.getElementById('dash-table-region');
  SB_UI.initActionMenus(tableRegion);
  SB_ACTIONS.wire(tableRegion, (id) => allRecent.find((c) => c.id === id), { onChange: refresh });

  document.getElementById('dash-search').addEventListener('input', SB_UI.debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderTable();
  }, 200));
  document.getElementById('dash-status-filter').addEventListener('change', (e) => {
    state.status = e.target.value;
    renderTable();
  });
  document.getElementById('dash-date-filter').addEventListener('change', (e) => {
    state.date = e.target.value;
    renderTable();
  });

  function renderStatCards(summary) {
    const cards = [
      {
        icon: SB_ICON.wallet, tone: 'brand', label: 'Total recebido',
        valor: summary.totalRecebido.valor, qtd: summary.totalRecebido.quantidade,
        trend: summary.totalRecebido.variacao,
      },
      {
        icon: SB_ICON.clock, tone: 'amber', label: 'Cobranças pendentes',
        valor: summary.pendentes.valor, qtd: summary.pendentes.quantidade,
      },
      {
        icon: SB_ICON.checkCircle, tone: 'green', label: 'Pagas hoje',
        valor: summary.pagasHoje.valor, qtd: summary.pagasHoje.quantidade,
      },
      {
        icon: SB_ICON.calendar, tone: 'blue', label: 'Vencendo em 7 dias',
        valor: summary.vencendo.valor, qtd: summary.vencendo.quantidade,
      },
      {
        icon: SB_ICON.alertTriangle, tone: 'red', label: 'Cobranças atrasadas',
        valor: summary.atrasadas.valor, qtd: summary.atrasadas.quantidade,
      },
    ];

    document.getElementById('stat-grid').innerHTML = cards.map((c) => `
      <div class="stat-card">
        <div class="stat-card__top">
          <span class="stat-card__icon stat-card__icon--${c.tone}">${c.icon}</span>
          ${c.trend !== undefined && c.trend !== null ? `
            <span class="stat-card__trend ${c.trend >= 0 ? 'is-up' : 'is-down'}">
              ${c.trend >= 0 ? SB_ICON.trendUp : SB_ICON.trendDown}
              ${Math.abs(c.trend).toFixed(1)}%
            </span>` : ''}
        </div>
        <div>
          <div class="stat-card__label">${c.label}</div>
          <div class="stat-card__value">${SB_UI.formatCurrency(c.valor)}</div>
          <div class="stat-card__count">${c.qtd} cobrança${c.qtd === 1 ? '' : 's'}${c.trend !== undefined && c.trend !== null ? ' · vs. mês anterior' : ''}</div>
        </div>
      </div>
    `).join('');
  }

  function filteredRows() {
    return allRecent.filter((c) => {
      if (state.status && c.status !== state.status) return false;
      if (state.date && c.vencimento.slice(0, 10) !== state.date) return false;
      if (state.search) {
        const haystack = `${c.cliente?.nome || ''} ${c.descricao} ${c.codigo}`.toLowerCase();
        if (!haystack.includes(state.search)) return false;
      }
      return true;
    });
  }

  function rowHtml(c) {
    const menuId = c.id;
    return `
      <tr>
        <td>
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(c.cliente?.nome)}</span>
            <div>
              <div class="table-cell-primary">${SB_UI.escapeHtml(c.cliente?.nome || 'Cliente removido')}</div>
              <div class="table-cell-muted">${c.codigo}</div>
            </div>
          </div>
        </td>
        <td>${SB_UI.escapeHtml(c.descricao)}</td>
        <td>${SB_UI.formatDate(c.vencimento)}</td>
        <td class="table-cell-primary">${SB_UI.formatCurrency(c.valor)}</td>
        <td>${SB_UI.badgeHtml(c.status)}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${menuId}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${menuId}">${SB_ACTIONS.rowMenuHtml(c)}</div>
          </div>
        </td>
      </tr>`;
  }

  function cardHtml(c) {
    const menuId = `m-${c.id}`;
    return `
      <div class="data-card">
        <div class="data-card__top">
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(c.cliente?.nome)}</span>
            <div>
              <div class="table-cell-primary">${SB_UI.escapeHtml(c.cliente?.nome || 'Cliente removido')}</div>
              <div class="table-cell-muted">${c.codigo}</div>
            </div>
          </div>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${menuId}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${menuId}">${SB_ACTIONS.rowMenuHtml(c)}</div>
          </div>
        </div>
        <div class="data-card__row"><span class="label">Descrição</span><span class="value">${SB_UI.escapeHtml(c.descricao)}</span></div>
        <div class="data-card__row"><span class="label">Vencimento</span><span class="value">${SB_UI.formatDate(c.vencimento)}</span></div>
        <div class="data-card__row"><span class="label">Valor</span><span class="value">${SB_UI.formatCurrency(c.valor)}</span></div>
        <div class="data-card__row"><span class="label">Status</span>${SB_UI.badgeHtml(c.status)}</div>
      </div>`;
  }

  function renderTable() {
    const rows = filteredRows();
    if (rows.length === 0) {
      tableRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.inbox}</div>
          <div class="state-block__title">${allRecent.length === 0 ? 'Nenhuma cobrança ainda' : 'Nenhum resultado encontrado'}</div>
          <p class="state-block__desc">${allRecent.length === 0 ? 'Crie sua primeira cobrança para começar a receber pagamentos.' : 'Tente ajustar a busca ou os filtros selecionados.'}</p>
          ${allRecent.length === 0 ? `<a href="cobranca-form.html" class="btn btn-primary btn-sm">${SB_ICON.plus}<span>Criar cobrança</span></a>` : ''}
        </div>`;
      return;
    }

    tableRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>Cliente</th><th>Descrição</th><th>Vencimento</th><th>Valor</th><th>Status</th><th class="text-right">Ações</th>
          </tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${rows.map(cardHtml).join('')}</div>`;
  }

  async function refresh() {
    const [summary, recent] = await Promise.all([
      DB.dashboard.summary(),
      DB.dashboard.recent(10),
    ]);
    allRecent = recent;
    renderStatCards(summary);
    renderTable();
  }

  try {
    await refresh();
  } catch (err) {
    document.getElementById('stat-grid').innerHTML = '';
    tableRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar o dashboard</div>
        <p class="state-block__desc">Ocorreu um erro ao buscar os dados. Tente novamente.</p>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`;
  }
})();
