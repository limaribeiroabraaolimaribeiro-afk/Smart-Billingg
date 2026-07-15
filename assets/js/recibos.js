/* ==========================================================================
   Smart Billing — Recibos page logic
   ========================================================================== */

(async function initRecibos() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  await SBLayout.mount({
    active: 'recibos',
    title: 'Recibos',
    breadcrumb: 'Painel <span>/</span> Recibos',
  });

  let all = [];
  const state = { search: '' };
  const listRegion = document.getElementById('list-region');
  SB_UI.initActionMenus(listRegion);

  document.getElementById('f-search').addEventListener('input', SB_UI.debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  }, 200));

  function filtered() {
    return all.filter((r) => {
      if (!state.search) return true;
      const haystack = `${r.cliente?.nome || ''} ${r.numero}`.toLowerCase();
      return haystack.includes(state.search);
    }).sort((a, b) => new Date(b.geradoEm) - new Date(a.geradoEm));
  }

  function receiptUrl(r) {
    return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}recibo-publico.html?token=${r.publicToken || r.id}`;
  }

  function menuHtml(r) {
    return `
      <button class="action-menu__item" data-act="view" data-id="${r.id}">${SB_ICON.eye}<span>Visualizar</span></button>
      <button class="action-menu__item" data-act="download" data-id="${r.id}">${SB_ICON.download}<span>Baixar PDF</span></button>
      <button class="action-menu__item" data-act="copy" data-id="${r.id}">${SB_ICON.link}<span>Copiar link</span></button>
      <div class="action-menu__divider"></div>
      <button class="action-menu__item" data-act="whatsapp" data-id="${r.id}">${SB_ICON.whatsapp}<span>Enviar pelo WhatsApp</span></button>
      <button class="action-menu__item" data-act="email" data-id="${r.id}">${SB_ICON.mail}<span>Enviar por e-mail</span></button>
    `;
  }

  function rowHtml(r) {
    return `
      <tr>
        <td class="table-cell-primary">${r.numero}</td>
        <td>
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(r.cliente?.nome)}</span>
            <span>${SB_UI.escapeHtml(r.cliente?.nome || 'Cliente removido')}</span>
          </div>
        </td>
        <td class="table-cell-muted">${r.cobranca?.codigo || '—'}</td>
        <td class="table-cell-primary">${SB_UI.formatCurrency(r.pagamento?.valor || 0)}</td>
        <td class="table-cell-muted">${SB_UI.formatDateTime(r.geradoEm)}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${r.id}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${r.id}">${menuHtml(r)}</div>
          </div>
        </td>
      </tr>`;
  }

  function cardHtml(r) {
    const menuId = `m-${r.id}`;
    return `
      <div class="data-card">
        <div class="data-card__top">
          <div class="cell-client">
            <span class="cell-client__avatar">${SB_UI.initials(r.cliente?.nome)}</span>
            <div>
              <div class="table-cell-primary">${r.numero}</div>
              <div class="table-cell-muted">${SB_UI.escapeHtml(r.cliente?.nome || 'Cliente removido')}</div>
            </div>
          </div>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${menuId}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${menuId}">${menuHtml(r)}</div>
          </div>
        </div>
        <div class="data-card__row"><span class="label">Cobrança</span><span class="value">${r.cobranca?.codigo || '—'}</span></div>
        <div class="data-card__row"><span class="label">Valor</span><span class="value">${SB_UI.formatCurrency(r.pagamento?.valor || 0)}</span></div>
        <div class="data-card__row"><span class="label">Gerado em</span><span class="value">${SB_UI.formatDateTime(r.geradoEm)}</span></div>
      </div>`;
  }

  function render() {
    const rows = filtered();
    if (rows.length === 0) {
      listRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.receipt}</div>
          <div class="state-block__title">${all.length === 0 ? 'Nenhum recibo gerado ainda' : 'Nenhum resultado encontrado'}</div>
          <p class="state-block__desc">${all.length === 0 ? 'Recibos são gerados automaticamente quando uma cobrança é paga.' : 'Tente ajustar sua busca.'}</p>
        </div>`;
      return;
    }
    listRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Recibo</th><th>Cliente</th><th>Cobrança</th><th>Valor</th><th>Gerado em</th><th class="text-right">Ações</th></tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${rows.map(cardHtml).join('')}</div>`;
  }

  listRegion.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const r = all.find((x) => x.id === btn.dataset.id);
    if (!r) return;
    const act = btn.dataset.act;

    if (act === 'view') { window.open(receiptUrl(r), '_blank'); return; }
    if (act === 'download') { SB_UI.toast({ type: 'success', title: 'Recibo baixado', desc: `${r.numero}.pdf` }); return; }
    if (act === 'copy') { await SB_UI.copyToClipboard(receiptUrl(r)); SB_UI.toast({ type: 'success', title: 'Link copiado' }); return; }
    if (act === 'whatsapp') {
      const msg = `Olá ${r.cliente?.nome || ''}! Segue o recibo ${r.numero} referente ao pagamento de ${SB_UI.formatCurrency(r.pagamento?.valor || 0)}: ${receiptUrl(r)}`;
      window.open(SB_UI.whatsappLink(r.cliente?.whatsapp, msg), '_blank');
      return;
    }
    if (act === 'email') { SB_UI.toast({ type: 'success', title: 'Recibo enviado por e-mail', desc: r.cliente?.email || '' }); }
  });

  try {
    all = await DB.recibos.list();
    render();
  } catch (err) {
    listRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar os recibos</div>
        <p class="state-block__desc">Tente novamente.</p>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`;
  }
})();
