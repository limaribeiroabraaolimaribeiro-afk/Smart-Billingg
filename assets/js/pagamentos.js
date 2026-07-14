/* ==========================================================================
   Smart Billing — Pagamentos page logic
   ========================================================================== */

(async function initPagamentos() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  await SBLayout.mount({
    active: 'pagamentos',
    title: 'Pagamentos',
    breadcrumb: 'Painel <span>/</span> Pagamentos',
  });

  let all = [];
  const state = { search: '', forma: '' };
  const listRegion = document.getElementById('list-region');

  document.getElementById('f-search').addEventListener('input', SB_UI.debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  }, 200));
  document.getElementById('f-forma').addEventListener('change', (e) => {
    state.forma = e.target.value;
    render();
  });

  function renderStats() {
    const total = all.reduce((s, p) => s + p.valor, 0);
    const qtd = all.length;
    const ticket = qtd ? total / qtd : 0;
    document.getElementById('pay-stats').innerHTML = `
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon stat-card__icon--brand">${SB_ICON.wallet}</span></div>
        <div><div class="stat-card__label">Total recebido</div><div class="stat-card__value">${SB_UI.formatCurrency(total)}</div><div class="stat-card__count">${qtd} pagamento${qtd === 1 ? '' : 's'}</div></div>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon stat-card__icon--green">${SB_ICON.checkCircle}</span></div>
        <div><div class="stat-card__label">Pagamentos confirmados</div><div class="stat-card__value">${qtd}</div><div class="stat-card__count">transações concluídas</div></div>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon stat-card__icon--blue">${SB_ICON.chart}</span></div>
        <div><div class="stat-card__label">Ticket médio</div><div class="stat-card__value">${SB_UI.formatCurrency(ticket)}</div><div class="stat-card__count">por transação</div></div>
      </div>`;
  }

  function filtered() {
    return all.filter((p) => {
      if (state.forma && p.forma !== state.forma) return false;
      if (state.search) {
        const haystack = `${p.cliente?.nome || ''} ${p.codigoTransacao} ${p.cobranca?.codigo || ''}`.toLowerCase();
        if (!haystack.includes(state.search)) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));
  }

  function formaLabel(forma, parcelas) {
    if (forma === 'pix') return 'Pix';
    if (forma === 'cartao') return parcelas > 1 ? `Cartão · ${parcelas}x` : 'Cartão · à vista';
    return forma;
  }

  function rowHtml(p) {
    return `
      <tr>
        <td>
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(p.cliente?.nome)}</span>
            <div>
              <div class="table-cell-primary">${SB_UI.escapeHtml(p.cliente?.nome || 'Cliente removido')}</div>
              <div class="table-cell-muted">${p.cobranca?.codigo || '—'}</div>
            </div>
          </div>
        </td>
        <td class="table-cell-primary">${SB_UI.formatCurrency(p.valor)}</td>
        <td>${formaLabel(p.forma, p.parcelas)}</td>
        <td class="table-cell-muted">${SB_UI.formatDateTime(p.dataHora)}</td>
        <td class="table-cell-muted">${p.codigoTransacao}</td>
        <td><span class="badge badge-paid">Confirmado</span></td>
      </tr>`;
  }

  function cardHtml(p) {
    return `
      <div class="data-card">
        <div class="data-card__top">
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(p.cliente?.nome)}</span>
            <div>
              <div class="table-cell-primary">${SB_UI.escapeHtml(p.cliente?.nome || 'Cliente removido')}</div>
              <div class="table-cell-muted">${p.cobranca?.codigo || '—'}</div>
            </div>
          </div>
          <span class="badge badge-paid">Confirmado</span>
        </div>
        <div class="data-card__row"><span class="label">Valor</span><span class="value">${SB_UI.formatCurrency(p.valor)}</span></div>
        <div class="data-card__row"><span class="label">Forma</span><span class="value">${formaLabel(p.forma, p.parcelas)}</span></div>
        <div class="data-card__row"><span class="label">Data</span><span class="value">${SB_UI.formatDateTime(p.dataHora)}</span></div>
        <div class="data-card__row"><span class="label">Transação</span><span class="value">${p.codigoTransacao}</span></div>
      </div>`;
  }

  function render() {
    const rows = filtered();
    if (rows.length === 0) {
      listRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.inbox}</div>
          <div class="state-block__title">${all.length === 0 ? 'Nenhum pagamento registrado' : 'Nenhum resultado encontrado'}</div>
          <p class="state-block__desc">${all.length === 0 ? 'Assim que uma cobrança for paga, ela aparecerá aqui.' : 'Tente ajustar a busca ou os filtros selecionados.'}</p>
        </div>`;
      return;
    }
    listRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Cliente</th><th>Valor</th><th>Forma de pagamento</th><th>Data e horário</th><th>Transação</th><th>Confirmação</th></tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${rows.map(cardHtml).join('')}</div>`;
  }

  try {
    all = await DB.pagamentos.list();
    renderStats();
    render();
  } catch (err) {
    document.getElementById('pay-stats').innerHTML = '';
    listRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar os pagamentos</div>
        <p class="state-block__desc">Tente novamente.</p>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`;
  }
})();
