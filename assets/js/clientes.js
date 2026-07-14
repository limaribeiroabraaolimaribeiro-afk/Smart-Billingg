/* ==========================================================================
   Smart Billing — Clientes (listing) page logic
   ========================================================================== */

(async function initClientes() {
  await SBLayout.mount({
    active: 'clientes',
    title: 'Clientes',
    breadcrumb: 'Painel <span>/</span> Clientes',
  });

  let all = [];
  const state = { search: '', sort: 'name-asc' };
  const listRegion = document.getElementById('list-region');
  SB_UI.initActionMenus(listRegion);

  document.getElementById('f-search').addEventListener('input', SB_UI.debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  }, 200));
  document.getElementById('f-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });

  function filteredSorted() {
    let rows = all.filter((c) => {
      if (!state.search) return true;
      const haystack = `${c.nome} ${c.whatsapp} ${c.email}`.toLowerCase();
      return haystack.includes(state.search);
    });
    const sorters = {
      'name-asc': (a, b) => a.nome.localeCompare(b.nome, 'pt-BR'),
      'recent': (a, b) => new Date(b.criadoEm) - new Date(a.criadoEm),
      'value-desc': (a, b) => b.totalRecebido - a.totalRecebido,
      'pending-desc': (a, b) => b.totalPendente - a.totalPendente,
    };
    rows.sort(sorters[state.sort]);
    return rows;
  }

  function menuHtml(c) {
    return `
      <a class="action-menu__item" href="cliente-historico.html?id=${c.id}">${SB_ICON.eye}<span>Ver histórico</span></a>
      <a class="action-menu__item" href="cobranca-form.html?clienteId=${c.id}">${SB_ICON.plus}<span>Nova cobrança</span></a>
      <a class="action-menu__item" href="cliente-form.html?id=${c.id}">${SB_ICON.edit}<span>Editar</span></a>
      <div class="action-menu__divider"></div>
      <button class="action-menu__item is-danger" data-act="delete" data-id="${c.id}">${SB_ICON.ban}<span>Excluir cliente</span></button>
    `;
  }

  function rowHtml(c) {
    return `
      <tr>
        <td>
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(c.nome)}</span>
            <a class="table-cell-primary" style="text-decoration:none;" href="cliente-historico.html?id=${c.id}">${SB_UI.escapeHtml(c.nome)}</a>
          </div>
        </td>
        <td>${SB_UI.escapeHtml(c.whatsapp)}</td>
        <td class="table-cell-muted">${SB_UI.escapeHtml(c.email || '—')}</td>
        <td>${c.quantidade}</td>
        <td class="table-cell-primary">${SB_UI.formatCurrency(c.totalRecebido)}</td>
        <td>${SB_UI.formatCurrency(c.totalPendente)}</td>
        <td class="table-cell-muted">${c.ultimaCobranca ? SB_UI.formatDate(c.ultimaCobranca) : '—'}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${c.id}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${c.id}">${menuHtml(c)}</div>
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
            <span class="cell-client__avatar">${SB_UI.initials(c.nome)}</span>
            <div>
              <div class="table-cell-primary">${SB_UI.escapeHtml(c.nome)}</div>
              <div class="table-cell-muted">${SB_UI.escapeHtml(c.whatsapp)}</div>
            </div>
          </div>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${menuId}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${menuId}">${menuHtml(c)}</div>
          </div>
        </div>
        <div class="data-card__row"><span class="label">E-mail</span><span class="value">${SB_UI.escapeHtml(c.email || '—')}</span></div>
        <div class="data-card__row"><span class="label">Cobranças</span><span class="value">${c.quantidade}</span></div>
        <div class="data-card__row"><span class="label">Recebido</span><span class="value">${SB_UI.formatCurrency(c.totalRecebido)}</span></div>
        <div class="data-card__row"><span class="label">Pendente</span><span class="value">${SB_UI.formatCurrency(c.totalPendente)}</span></div>
      </div>`;
  }

  function render() {
    const rows = filteredSorted();

    if (rows.length === 0) {
      listRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.users}</div>
          <div class="state-block__title">${all.length === 0 ? 'Nenhum cliente cadastrado' : 'Nenhum resultado encontrado'}</div>
          <p class="state-block__desc">${all.length === 0 ? 'Cadastre seu primeiro cliente para começar a criar cobranças.' : 'Tente ajustar sua busca.'}</p>
          <a href="cliente-form.html" class="btn btn-primary btn-sm">${SB_ICON.plus}<span>Novo cliente</span></a>
        </div>`;
      return;
    }

    listRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>Nome</th><th>WhatsApp</th><th>E-mail</th><th>Cobranças</th><th>Recebido</th><th>Pendente</th><th>Última cobrança</th><th class="text-right">Ações</th>
          </tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${rows.map(cardHtml).join('')}</div>`;
  }

  listRegion.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="delete"]');
    if (!btn) return;
    const cliente = all.find((c) => c.id === btn.dataset.id);
    if (!cliente) return;
    const ok = await SB_UI.confirmDialog({
      title: 'Excluir cliente',
      desc: `Tem certeza que deseja excluir "${cliente.nome}"? As cobranças associadas permanecerão no histórico, mas o vínculo com o cliente será perdido.`,
      confirmLabel: 'Excluir cliente',
      cancelLabel: 'Cancelar',
      tone: 'danger',
    });
    if (!ok) return;
    await DB.clientes.remove(cliente.id);
    SB_UI.toast({ type: 'info', title: 'Cliente excluído', desc: `${cliente.nome} foi removido.` });
    load();
  });

  async function load() {
    try {
      all = await DB.clientes.listWithStats();
      render();
    } catch (err) {
      listRegion.innerHTML = `
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Não foi possível carregar os clientes</div>
          <p class="state-block__desc">Ocorreu um erro ao buscar os dados. Tente novamente.</p>
          <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
        </div>`;
    }
  }

  load();
})();
