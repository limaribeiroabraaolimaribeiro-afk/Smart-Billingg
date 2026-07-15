/* ==========================================================================
   Smart Billing — Retorno do Checkout Integrado da InfinitePay
   --------------------------------------------------------------------------
   Acessada via redirect_url configurada em create-infinitepay-checkout:
   pagamento-confirmado.html?token=<public_token da cobrança>. A InfinitePay
   pode anexar outros parâmetros ao redirecionar (order_nsu, transaction_nsu,
   slug, capture_method, receipt_url) — mas a aprovação NUNCA é exibida só
   por esses parâmetros terem chegado na URL. A confirmação real vem sempre
   da Edge Function check-infinitepay-payment, que por sua vez só confirma
   depois de consultar a InfinitePay (payment_check).
   ========================================================================== */

(async function initConfirmacaoCheckout() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('id');
  const orderNsu = params.get('order_nsu') || '';
  const transactionNsu = params.get('transaction_nsu') || '';
  const slug = params.get('slug') || '';
  const captureMethod = params.get('capture_method') || '';

  const region = document.getElementById('confirm-region');

  function renderState(inner) {
    region.innerHTML = `<div class="confirm-card">${inner}</div>`;
  }

  function errorState(title, desc) {
    renderState(`
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">${title}</div>
        <p class="state-block__desc">${desc}</p>
      </div>`);
  }

  function verifyingState() {
    renderState(`
      <div class="skeleton" style="height:76px;width:76px;border-radius:50%;margin:0 auto 20px;"></div>
      <div class="confirm-title">Verificando pagamento…</div>
      <p class="confirm-desc">Aguarde enquanto confirmamos seu pagamento com a InfinitePay.</p>`);
  }

  function processingState() {
    renderState(`
      <div class="state-block">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Pagamento em processamento</div>
        <p class="state-block__desc">Aguarde alguns instantes. Isso pode levar alguns segundos após a confirmação da InfinitePay.</p>
        <button class="btn btn-secondary btn-sm" id="btn-retry">Tentar novamente</button>
      </div>`);
    document.getElementById('btn-retry')?.addEventListener('click', () => runCheck({ manual: true }));
  }

  function approvedState(info) {
    const formaLabel = info.payment_method === 'pix'
      ? 'Pix'
      : `Cartão${info.installments > 1 ? ` · ${info.installments}x` : ' · à vista'}`;

    renderState(`
      <div class="confirm-check">${SB_ICON.checkCircle}</div>
      <div class="confirm-title">Pagamento aprovado!</div>
      <p class="confirm-desc">Seu pagamento foi confirmado com sucesso.</p>
      <div class="confirm-amount">${SB_UI.formatCurrency(info.amount || 0)}</div>
      <div class="confirm-details">
        <div class="summary-row"><span class="label">Forma de pagamento</span><span class="value">${formaLabel}</span></div>
        <div class="summary-row"><span class="label">Cobrança</span><span class="value">${info.charge_number || '—'}</span></div>
      </div>
      ${info.receipt_token ? `
        <div class="confirm-actions">
          <a class="btn btn-secondary btn-block" href="recibo-publico.html?token=${info.receipt_token}" target="_blank" rel="noopener">${SB_ICON.download}<span>Ver recibo</span></a>
        </div>` : ''}
      <div class="public-footer-logo" style="opacity:.85;margin-top:24px;">
        <img src="assets/img/logo.svg" alt="" />
        <span style="color:var(--text-muted);">Smart Billing</span>
      </div>`);
  }

  if (!token) {
    errorState('Cobrança não encontrada', 'O link acessado é inválido ou está incompleto.');
    return;
  }

  document.title = 'Verificando pagamento · Smart Billing';

  let autoRetried = false;

  async function runCheck({ manual = false } = {}) {
    verifyingState();

    // Sem os parâmetros de confirmação da InfinitePay não há como consultar o
    // payment_check ainda — trata como "em processamento" em vez de erro.
    if (!orderNsu || !transactionNsu || !slug) {
      processingState();
      return;
    }

    let result;
    try {
      result = await DB.cobrancas.checkInfinitePayPayment({
        token, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug, capture_method: captureMethod,
      });
    } catch (err) {
      result = null;
    }

    if (result && result.success && result.paid) {
      document.title = 'Pagamento aprovado · Smart Billing';
      approvedState(result);
      return;
    }

    processingState();

    if (!manual && !autoRetried) {
      autoRetried = true;
      setTimeout(() => runCheck({ manual: true }), 4000);
    }
  }

  await runCheck();
})();
