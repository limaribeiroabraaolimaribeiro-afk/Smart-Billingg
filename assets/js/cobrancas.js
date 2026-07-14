/* ==========================================================================
   Smart Billing — Cobranças (listing) page logic
   ========================================================================== */

(async function initCobrancas() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  await SBLayout.mount({
    active: 'cobrancas',
    title: 'Cobranças',
    breadcrumb: 'Painel <span>/</span> Cobranças',
    hidePrimaryAction: true,
  });

  let all = [];
  const state = { search: '', status: '', period: '', due: '', sort: 'date-desc', page: 1 };
  const PAGE_SIZE = 8;

  const listRegion = document.getElementById('list-region');
  const pagRegion = document.getElementById('pagination-region');
  SB_UI.initActionMenus(listRegion);
  SB_ACTIONS.wire(listRegion, (id) => all.find((c) => c.id === id), { onChange: load });

  document.getElementById('f-search').addEventListener('input', SB_UI.debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    state.page = 1; render();
  }, 200));
  document.getElementById('f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; render(); });
  document.getElementById('f-period').addEventListener('change', (e) => { state.period = e.target.value; state.page = 1; render(); });
  document.getElementById('f-due').addEventListener('change', (e) => { state.due = e.target.value; state.page = 1; render(); });
  document.getElementById('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

  function filteredSorted() {
    let rows = all.filter((c) => {
      if (state.status && c.status !== state.status) return false;
      if (state.due && c.vencimento.slice(0, 10) !== state.due) return false;
      if (state.period) {
        const days = (Date.now() - new Date(c.criadoEm)) / 86400000;
        if (days > Number(state.period)) return false;
      }
      if (state.search) {
        const haystack = `${c.cliente?.nome || ''} ${c.descricao} ${c.codigo}`.toLowerCase();
        if (!haystack.includes(state.search)) return false;
      }
      return true;
    });

    const sorters = {
      'date-desc': (a, b) => new Date(b.criadoEm) - new Date(a.criadoEm),
      'date-asc': (a, b) => new Date(a.criadoEm) - new Date(b.criadoEm),
      'value-desc': (a, b) => b.valor - a.valor,
      'value-asc': (a, b) => a.valor - b.valor,
      'due-asc': (a, b) => new Date(a.vencimento) - new Date(b.vencimento),
    };
    rows.sort(sorters[state.sort]);
    return rows;
  }

  function rowHtml(c) {
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
            <button class="action-btn" data-menu-toggle="${c.id}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${c.id}">${SB_ACTIONS.rowMenuHtml(c)}</div>
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

  function render() {
    const rows = filteredSorted();
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const pageRows = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

    if (rows.length === 0) {
      listRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.inbox}</div>
          <div class="state-block__title">${all.length === 0 ? 'Nenhuma cobrança cadastrada' : 'Nenhum resultado encontrado'}</div>
          <p class="state-block__desc">${all.length === 0 ? 'Crie sua primeira cobrança para começar a receber pagamentos.' : 'Tente ajustar a busca ou os filtros selecionados.'}</p>
          <a href="cobranca-form.html" class="btn btn-primary btn-sm">${SB_ICON.plus}<span>Nova cobrança</span></a>
        </div>`;
      pagRegion.innerHTML = '';
      return;
    }

    listRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>Cliente</th><th>Descrição</th><th>Vencimento</th><th>Valor</th><th>Status</th><th class="text-right">Ações</th>
          </tr></thead>
          <tbody>${pageRows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${pageRows.map(cardHtml).join('')}</div>`;

    renderPagination(totalPages, rows.length);
  }

  function renderPagination(totalPages, totalRows) {
    const start = (state.page - 1) * PAGE_SIZE + 1;
    const end = Math.min(state.page * PAGE_SIZE, totalRows);
    let pageBtns = '';
    for (let p = 1; p <= totalPages; p += 1) {
      if (totalPages > 7 && Math.abs(p - state.page) > 2 && p !== 1 && p !== totalPages) {
        if (p === 2 || p === totalPages - 1) pageBtns += `<span class="page-btn" style="pointer-events:none;">…</span>`;
        continue;
      }
      pageBtns += `<button class="page-btn${p === state.page ? ' is-active' : ''}" data-page="${p}">${p}</button>`;
    }

    pagRegion.innerHTML = `
      <div class="pagination">
        <span class="pagination-info">Mostrando ${start}–${end} de ${totalRows} cobranças</span>
        <div class="pagination-controls">
          <button class="page-btn" id="pg-prev" ${state.page === 1 ? 'disabled' : ''}>${SB_ICON.chevronLeft}</button>
          ${pageBtns}
          <button class="page-btn" id="pg-next" ${state.page === totalPages ? 'disabled' : ''}>${SB_ICON.chevronRight}</button>
        </div>
      </div>`;

    pagRegion.querySelectorAll('[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => { state.page = Number(btn.dataset.page); render(); });
    });
    document.getElementById('pg-prev')?.addEventListener('click', () => { state.page -= 1; render(); });
    document.getElementById('pg-next')?.addEventListener('click', () => { state.page += 1; render(); });
  }

  async function load() {
    try {
      all = await DB.cobrancas.list();
      render();
    } catch (err) {
      listRegion.innerHTML = `
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Não foi possível carregar as cobranças</div>
          <p class="state-block__desc">Ocorreu um erro ao buscar os dados. Tente novamente.</p>
          <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
        </div>`;
    }
  }

  load();
})();
