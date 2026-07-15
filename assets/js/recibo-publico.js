/* ==========================================================================
   Smart Billing — Visualização pública de recibo
   --------------------------------------------------------------------------
   Acessível sem login via ?token=<public_token do recibo>. Usada a partir
   de Recibos (visualizar / enviar por WhatsApp / enviar por e-mail).
   ========================================================================== */

(async function initRecibo() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('id');
  const region = document.getElementById('confirm-region');

  function renderState(inner) {
    region.innerHTML = `<div class="confirm-card">${inner}</div>`;
  }

  if (!token) {
    renderState(`
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Recibo não encontrado</div>
        <p class="state-block__desc">O link acessado é inválido.</p>
      </div>`);
    return;
  }

  try {
    const recibo = await DB.recibos.getByPublicToken(token);

    if (!recibo) {
      renderState(`
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Recibo não encontrado</div>
          <p class="state-block__desc">Ele pode ter sido removido ou o link está incorreto.</p>
        </div>`);
      return;
    }

    document.title = `Recibo ${recibo.numero} · Smart Billing`;
    const pagamento = recibo.pagamento || {};
    const formaLabel = pagamento.forma === 'pix' ? 'Pix' : `Cartão${pagamento.parcelas > 1 ? ` · ${pagamento.parcelas}x` : ' · à vista'}`;

    renderState(`
      <div class="confirm-check">${SB_ICON.checkCircle}</div>
      <div class="confirm-title">Pagamento aprovado!</div>
      <p class="confirm-desc">O pagamento de ${SB_UI.escapeHtml(recibo.cliente?.nome || 'cliente')} foi confirmado.</p>
      <div class="confirm-amount">${SB_UI.formatCurrency(pagamento.valor || 0)}</div>
      <div class="confirm-details">
        <div class="summary-row"><span class="label">Forma de pagamento</span><span class="value">${formaLabel}</span></div>
        <div class="summary-row"><span class="label">Data e horário</span><span class="value">${SB_UI.formatDateTime(pagamento.dataHora || recibo.geradoEm)}</span></div>
        ${pagamento.codigoTransacao ? `<div class="summary-row"><span class="label">Código da transação</span><span class="value">${SB_UI.escapeHtml(pagamento.codigoTransacao)}</span></div>` : ''}
        <div class="summary-row"><span class="label">Cobrança</span><span class="value">${recibo.cobranca?.codigo || '—'}</span></div>
        <div class="summary-row"><span class="label">Recibo</span><span class="value">${recibo.numero}</span></div>
      </div>
      <div class="confirm-actions">
        <button class="btn btn-secondary btn-block" id="btn-download-receipt">${SB_ICON.download}<span>Baixar recibo em PDF</span></button>
      </div>
      <div class="public-footer-logo" style="opacity:.85;margin-top:24px;">
        <img src="assets/img/logo.svg" alt="" />
        <span style="color:var(--text-muted);">Smart Billing</span>
      </div>
    `);

    document.getElementById('btn-download-receipt').addEventListener('click', () => {
      SB_UI.toast({ type: 'success', title: 'Download iniciado', desc: `${recibo.numero}.pdf` });
    });
  } catch (err) {
    renderState(`
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar o comprovante</div>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`);
  }
})();
