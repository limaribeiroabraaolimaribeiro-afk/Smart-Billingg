/* ==========================================================================
   Smart Billing — Confirmação de pagamento
   ========================================================================== */

(async function initConfirmacao() {
  const params = new URLSearchParams(window.location.search);
  const cobrancaId = params.get('id');
  const region = document.getElementById('confirm-region');

  function renderState(inner) {
    region.innerHTML = `<div class="confirm-card">${inner}</div>`;
  }

  if (!cobrancaId) {
    renderState(`
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Pagamento não encontrado</div>
        <p class="state-block__desc">O link acessado é inválido.</p>
      </div>`);
    return;
  }

  try {
    const [cobranca, pagamentos] = await Promise.all([DB.cobrancas.get(cobrancaId), DB.pagamentos.list()]);

    if (!cobranca) {
      renderState(`
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Cobrança não encontrada</div>
          <p class="state-block__desc">Ela pode ter sido removida.</p>
        </div>`);
      return;
    }

    const pagamento = pagamentos
      .filter((p) => p.cobrancaId === cobrancaId)
      .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora))[0];

    if (!pagamento) {
      renderState(`
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.clock}</div>
          <div class="state-block__title">Esta cobrança ainda não foi paga</div>
          <p class="state-block__desc">Assim que o pagamento for confirmado, o comprovante aparecerá aqui.</p>
          <a class="btn btn-primary btn-sm" href="cobranca-publica.html?id=${cobranca.id}">Ir para pagamento</a>
        </div>`);
      return;
    }

    document.title = 'Pagamento confirmado · Smart Billing';
    const formaLabel = pagamento.forma === 'pix' ? 'Pix' : `Cartão${pagamento.parcelas > 1 ? ` · ${pagamento.parcelas}x` : ' · à vista'}`;

    renderState(`
      <div class="confirm-check">${SB_ICON.checkCircle}</div>
      <div class="confirm-title">Pagamento aprovado!</div>
      <p class="confirm-desc">O pagamento de ${SB_UI.escapeHtml(cobranca.cliente?.nome || 'cliente')} foi processado com sucesso.</p>
      <div class="confirm-amount">${SB_UI.formatCurrency(pagamento.valor)}</div>
      <div class="confirm-details">
        <div class="summary-row"><span class="label">Forma de pagamento</span><span class="value">${formaLabel}</span></div>
        <div class="summary-row"><span class="label">Data e horário</span><span class="value">${SB_UI.formatDateTime(pagamento.dataHora)}</span></div>
        <div class="summary-row"><span class="label">Código da transação</span><span class="value">${pagamento.codigoTransacao}</span></div>
        <div class="summary-row"><span class="label">Cobrança</span><span class="value">${cobranca.codigo}</span></div>
      </div>
      <div class="confirm-actions">
        <button class="btn btn-primary btn-block" id="btn-view-receipt">${SB_ICON.receipt}<span>Visualizar recibo</span></button>
        <button class="btn btn-secondary btn-block" id="btn-download-receipt">${SB_ICON.download}<span>Baixar recibo em PDF</span></button>
      </div>
      <div class="public-footer-logo" style="opacity:.85;margin-top:24px;">
        <img src="assets/img/logo.svg" alt="" />
        <span style="color:var(--text-muted);">Smart Billing</span>
      </div>
    `);

    document.getElementById('btn-view-receipt').addEventListener('click', () => {
      SB_UI.toast({ type: 'success', title: 'Recibo', desc: `Recibo referente à cobrança ${cobranca.codigo} exibido.` });
    });
    document.getElementById('btn-download-receipt').addEventListener('click', () => {
      SB_UI.toast({ type: 'success', title: 'Download iniciado', desc: `recibo-${cobranca.codigo}.pdf` });
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
