/* ==========================================================================
   Smart Billing — Página pública da cobrança
   --------------------------------------------------------------------------
   Acessível sem login, via ?token=<public_token>. Não expõe IDs internos
   nem dados privados da empresa. Enquanto a cobrança não tiver checkout_url
   configurado, o botão "Pagar agora" apenas informa que o checkout ainda
   não foi configurado — nenhum pagamento é simulado/aprovado aqui.
   ========================================================================== */

(async function initPublicCharge() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('id');
  const region = document.getElementById('public-region');

  // Domínios oficiais do checkout hospedado pela InfinitePay (mesma lista
  // usada em supabase/functions/_shared/infinitepay.ts). Só redireciona para
  // URLs https com hostname EXATO nesta lista — nunca confia cegamente no
  // valor salvo no banco, nem usa includes()/substring (aceitaria hosts
  // forjados como "checkout.infinitepay.io.site-falso.com").
  const INFINITEPAY_CHECKOUT_HOSTS = new Set([
    'checkout.infinitepay.com.br',
    'checkout.infinitepay.io',
  ]);

  function isTrustedCheckoutUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && INFINITEPAY_CHECKOUT_HOSTS.has(parsed.hostname.toLowerCase());
    } catch (err) {
      return false;
    }
  }

  function shell(inner) {
    return `<div class="public-card">${inner}</div>`;
  }

  function errorState(title, desc) {
    region.innerHTML = shell(`
      <div class="public-card__body" style="margin-top:0;padding-top:48px;">
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">${title}</div>
          <p class="state-block__desc">${desc}</p>
        </div>
      </div>`);
  }

  if (!token) { errorState('Cobrança não encontrada', 'O link acessado é inválido ou está incompleto.'); return; }

  let cobranca;
  try {
    cobranca = await DB.cobrancas.getByPublicToken(token);
  } catch (err) {
    errorState('Erro ao carregar cobrança', 'Não foi possível buscar os dados. Tente novamente em instantes.');
    return;
  }

  if (!cobranca) { errorState('Cobrança não encontrada', 'O link acessado é inválido ou a cobrança foi removida.'); return; }

  const empresaNome = cobranca.empresaNome || 'Smart Billing';
  document.title = `Cobrança ${cobranca.codigo} · Smart Billing`;

  const clienteNome = cobranca.cliente?.nome || 'Cliente';
  const statusMeta = SB_UI.statusMeta(cobranca.status);

  function heroBlock() {
    return `
      <div class="public-card__hero">
        <span class="badge ${statusMeta.cls} public-status-pill" style="background:rgba(255,255,255,.2);color:#fff;">${statusMeta.label}</span>
        <img class="public-card__logo" src="assets/img/logo.svg" alt="Smart Billing" />
        <div class="public-card__company">${SB_UI.escapeHtml(empresaNome)}</div>
        <div class="public-card__client">Cobrança para ${SB_UI.escapeHtml(clienteNome)}</div>
        <div class="public-card__amount-label">Valor a pagar</div>
        <div class="public-card__amount">${SB_UI.formatCurrency(cobranca.valor)}</div>
      </div>`;
  }

  function infoPanel() {
    return `
      <div class="public-card__panel">
        <div class="public-info-row">
          <span class="label">${SB_ICON.calendar}Vencimento</span>
          <span class="value">${SB_UI.formatDate(cobranca.vencimento)}</span>
        </div>
        <div class="public-info-row">
          <span class="label">${SB_ICON.invoice}Descrição</span>
          <span class="value">${SB_UI.escapeHtml(cobranca.descricao)}</span>
        </div>
        <div class="public-info-row">
          <span class="label">${SB_ICON.key}Código</span>
          <span class="value">${cobranca.codigo}</span>
        </div>
        <div class="public-info-row">
          <span class="label">${SB_ICON.building}Empresa</span>
          <span class="value">${SB_UI.escapeHtml(empresaNome)}</span>
        </div>
      </div>`;
  }

  function footerLogo() {
    return `
      <div class="public-footer-logo">
        <img class="public-footer-logo__wordmark" src="assets/img/logo.png" alt="Smart Billing" />
      </div>`;
  }

  function appendFooter() {
    document.getElementById('public-region').insertAdjacentHTML('beforeend', `<div style="text-align:center;">${footerLogo()}</div>`);
  }

  // ---- Already paid ----
  if (cobranca.status === 'pago') {
    region.innerHTML = shell(`
      ${heroBlock()}
      <div class="public-card__body">
        ${infoPanel()}
        <div class="state-block" style="padding-top:24px;">
          <div class="state-block__icon" style="background:var(--green-100);color:var(--green-700);">${SB_ICON.checkCircle}</div>
          <div class="state-block__title">Esta cobrança já foi paga</div>
          <p class="state-block__desc">Pagamento confirmado em ${SB_UI.formatDate(cobranca.pagoEm)}.</p>
        </div>
      </div>`);
    appendFooter();
    return;
  }

  // ---- Cancelled ----
  if (cobranca.status === 'cancelado') {
    region.innerHTML = shell(`
      ${heroBlock()}
      <div class="public-card__body">
        ${infoPanel()}
        <div class="state-block is-error" style="padding-top:24px;">
          <div class="state-block__icon">${SB_ICON.ban}</div>
          <div class="state-block__title">Cobrança cancelada</div>
          <p class="state-block__desc">Esta cobrança não está mais disponível para pagamento. Entre em contato com ${SB_UI.escapeHtml(empresaNome)} caso tenha dúvidas.</p>
        </div>
      </div>`);
    appendFooter();
    return;
  }

  // ---- Overdue notice (still payable, just flagged) ----
  const overdueNotice = cobranca.status === 'atrasado' ? `
    <div class="auth-alert" style="margin-top:16px;">
      ${SB_ICON.alertTriangle}
      <span>Esta cobrança está vencida desde ${SB_UI.formatDate(cobranca.vencimento)}. Regularize o quanto antes.</span>
    </div>` : '';

  // ---- Payable state (pendente / atrasado) ----
  const acceptsPix = cobranca.formaPagamento === 'pix' || cobranca.formaPagamento === 'ambos';
  const acceptsCartao = cobranca.formaPagamento === 'cartao' || cobranca.formaPagamento === 'ambos';
  const defaultMethod = acceptsPix ? 'pix' : 'cartao';
  const hasCheckout = Boolean(cobranca.checkoutUrl);

  region.innerHTML = shell(`
    ${heroBlock()}
    <div class="public-card__body">
      ${infoPanel()}
      ${overdueNotice}

      <div class="public-section-title">Forma de pagamento</div>
      <div class="pay-method-grid">
        ${acceptsPix ? `
          <label class="option-toggle ${defaultMethod === 'pix' ? 'is-checked' : ''}" id="method-pix">
            <input type="radio" name="method" value="pix" ${defaultMethod === 'pix' ? 'checked' : ''} />
            <span class="option-toggle__icon">${SB_ICON.pix}</span>
            <span><span class="option-toggle__title">Pix</span><br/><span class="option-toggle__desc">Instantâneo</span></span>
          </label>` : ''}
        ${acceptsCartao ? `
          <label class="option-toggle ${defaultMethod === 'cartao' ? 'is-checked' : ''}" id="method-cartao">
            <input type="radio" name="method" value="cartao" ${defaultMethod === 'cartao' ? 'checked' : ''} />
            <span class="option-toggle__icon">${SB_ICON.card}</span>
            <span><span class="option-toggle__title">Cartão</span><br/><span class="option-toggle__desc">Até ${cobranca.parcelas}x</span></span>
          </label>` : ''}
      </div>

      <div class="field installments-select" id="installments-wrap" style="display:${defaultMethod === 'cartao' ? 'block' : 'none'};">
        <label for="parcelas-select">Parcelamento</label>
        <select class="select" id="parcelas-select">
          ${Array.from({ length: cobranca.parcelas || 1 }, (_, i) => i + 1).map((n) => `
            <option value="${n}">${n}x de ${SB_UI.formatCurrency(cobranca.valor / n)}${n === 1 ? ' à vista' : ''}</option>`).join('')}
        </select>
      </div>

      <button class="btn btn-primary btn-block pay-btn-fixed" id="pay-btn">
        <span id="pay-btn-label">Pagar agora · ${SB_UI.formatCurrency(cobranca.valor)}</span>
      </button>

      <div class="secure-note">
        ${SB_ICON.shield}
        <span>Ambiente seguro · Pagamento criptografado</span>
      </div>
    </div>
  `);
  appendFooter();

  document.querySelectorAll('input[name="method"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.option-toggle').forEach((el) => el.classList.remove('is-checked'));
      radio.closest('.option-toggle').classList.add('is-checked');
      document.getElementById('installments-wrap').style.display = radio.value === 'cartao' ? 'block' : 'none';
      updatePayLabel();
    });
  });
  document.getElementById('parcelas-select')?.addEventListener('change', updatePayLabel);

  function selectedMethod() {
    return document.querySelector('input[name="method"]:checked')?.value || defaultMethod;
  }

  function updatePayLabel() {
    const label = document.getElementById('pay-btn-label');
    if (selectedMethod() === 'cartao') {
      const n = Number(document.getElementById('parcelas-select')?.value || 1);
      label.textContent = n > 1
        ? `Pagar ${n}x de ${SB_UI.formatCurrency(cobranca.valor / n)}`
        : `Pagar agora · ${SB_UI.formatCurrency(cobranca.valor)}`;
    } else {
      label.textContent = `Pagar agora · ${SB_UI.formatCurrency(cobranca.valor)}`;
    }
  }

  document.getElementById('pay-btn').addEventListener('click', () => {
    if (!hasCheckout) {
      SB_UI.toast({
        type: 'info',
        title: 'O link de pagamento ainda não foi gerado.',
        desc: 'Tente novamente em instantes ou entre em contato com quem emitiu a cobrança.',
        duration: 5000,
      });
      return;
    }
    if (!isTrustedCheckoutUrl(cobranca.checkoutUrl)) {
      SB_UI.toast({ type: 'error', title: 'Não foi possível abrir o pagamento', desc: 'Tente novamente em instantes.' });
      return;
    }
    // Redireciona para o Checkout Integrado real da InfinitePay.
    window.location.href = cobranca.checkoutUrl;
  });
})();
