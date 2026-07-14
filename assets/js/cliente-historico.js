/* ==========================================================================
   Smart Billing — Histórico financeiro do cliente
   ========================================================================== */

(async function initClienteHistorico() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const clienteId = params.get('id');

  await SBLayout.mount({
    active: 'clientes',
    title: 'Histórico do cliente',
    breadcrumb: 'Painel <span>/</span> Clientes <span>/</span> Histórico',
  });

  const profileRegion = document.getElementById('profile-region');
  const miniStats = document.getElementById('mini-stats');
  const historyRegion = document.getElementById('history-region');

  if (!clienteId) {
    profileRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Cliente não informado</div>
        <p class="state-block__desc">Volte para a lista de clientes e selecione um cliente.</p>
        <a href="clientes.html" class="btn btn-secondary btn-sm">Voltar</a>
      </div>`;
    return;
  }

  let cobrancasCliente = [];
  let cliente = null;

  try {
    let stats;
    [cliente, stats] = await Promise.all([DB.clientes.get(clienteId), DB.clientes.stats(clienteId)]);
    if (!cliente) {
      profileRegion.innerHTML = `
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Cliente não encontrado</div>
          <p class="state-block__desc">Ele pode ter sido removido.</p>
          <a href="clientes.html" class="btn btn-secondary btn-sm">Voltar para clientes</a>
        </div>`;
      return;
    }

    document.title = `${cliente.nome} · Smart Billing`;
    cobrancasCliente = stats.cobrancas.map((c) => ({ ...c, cliente }));

    profileRegion.innerHTML = `
      <div class="card card-pad profile-header">
        <span class="profile-avatar">${SB_UI.initials(cliente.nome)}</span>
        <div>
          <div class="profile-meta__name">${SB_UI.escapeHtml(cliente.nome)}</div>
          <div class="profile-meta__row">
            <span>${SB_ICON.phone}</span><span>${SB_UI.escapeHtml(cliente.whatsapp)}</span>
            ${cliente.email ? `<span style="margin-left:8px;">${SB_ICON.mail}</span><span>${SB_UI.escapeHtml(cliente.email)}</span>` : ''}
          </div>
        </div>
        <div class="profile-actions">
          <a href="cliente-form.html?id=${cliente.id}" class="btn btn-secondary">${SB_ICON.edit}<span>Editar cliente</span></a>
          <a href="cobranca-form.html?clienteId=${cliente.id}" class="btn btn-primary">${SB_ICON.plus}<span>Nova cobrança</span></a>
        </div>
      </div>`;

    miniStats.style.display = 'grid';
    miniStats.innerHTML = `
      <div class="mini-stat"><div class="mini-stat__label">Total de cobranças</div><div class="mini-stat__value">${stats.quantidade}</div></div>
      <div class="mini-stat"><div class="mini-stat__label">Total recebido</div><div class="mini-stat__value">${SB_UI.formatCurrency(stats.totalRecebido)}</div></div>
      <div class="mini-stat"><div class="mini-stat__label">Total pendente</div><div class="mini-stat__value">${SB_UI.formatCurrency(stats.totalPendente)}</div></div>
    `;

    renderHistory();
  } catch (err) {
    profileRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar o cliente</div>
        <p class="state-block__desc">Tente novamente.</p>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`;
  }

  function rowHtml(c) {
    return `
      <tr>
        <td class="table-cell-primary">${c.codigo}</td>
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

  function renderHistory() {
    if (cobrancasCliente.length === 0) {
      historyRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.inbox}</div>
          <div class="state-block__title">Nenhuma cobrança para este cliente</div>
          <p class="state-block__desc">Crie a primeira cobrança para este cliente.</p>
          <a href="cobranca-form.html?clienteId=${clienteId}" class="btn btn-primary btn-sm">${SB_ICON.plus}<span>Nova cobrança</span></a>
        </div>`;
      return;
    }

    historyRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Código</th><th>Descrição</th><th>Vencimento</th><th>Valor</th><th>Status</th><th class="text-right">Ações</th></tr></thead>
          <tbody>${cobrancasCliente.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${cobrancasCliente.map((c) => `
        <div class="data-card">
          <div class="data-card__top">
            <span class="table-cell-primary">${c.codigo}</span>
            ${SB_UI.badgeHtml(c.status)}
          </div>
          <div class="data-card__row"><span class="label">Descrição</span><span class="value">${SB_UI.escapeHtml(c.descricao)}</span></div>
          <div class="data-card__row"><span class="label">Vencimento</span><span class="value">${SB_UI.formatDate(c.vencimento)}</span></div>
          <div class="data-card__row"><span class="label">Valor</span><span class="value">${SB_UI.formatCurrency(c.valor)}</span></div>
        </div>`).join('')}</div>`;

    SB_UI.initActionMenus(historyRegion);
    SB_ACTIONS.wire(historyRegion, (id) => cobrancasCliente.find((c) => c.id === id), {
      onChange: async () => {
        const stats = await DB.clientes.stats(clienteId);
        cobrancasCliente = stats.cobrancas.map((c) => ({ ...c, cliente }));
        renderHistory();
      },
    });
  }
})();
