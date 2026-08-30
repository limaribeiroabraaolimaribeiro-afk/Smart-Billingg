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

  // valorAtualizado já vem calculado do servidor (banco em modo real,
  // calculateLateCharges em modo demo) — nunca calculado aqui. Sem atraso,
  // é sempre igual a cobranca.valor.
  const valorExibido = cobranca.valorAtualizado != null ? cobranca.valorAtualizado : cobranca.valor;
  const temEncargos = cobranca.status === 'atrasado' && (cobranca.diasAtraso || 0) > 0 && valorExibido > cobranca.valor;

  function heroBlock() {
    return `
      <div class="public-card__hero">
        <span class="badge ${statusMeta.cls} public-status-pill" style="background:rgba(255,255,255,.2);color:#fff;">${statusMeta.label}</span>
        <img class="public-card__logo" src="assets/img/logo.svg" alt="Smart Billing" />
        <div class="public-card__company">${SB_UI.escapeHtml(empresaNome)}</div>
        <div class="public-card__client">Cobrança para ${SB_UI.escapeHtml(clienteNome)}</div>
        <div class="public-card__amount-label">Valor a pagar</div>
        <div class="public-card__amount">${SB_UI.formatCurrency(valorExibido)}</div>
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

  // ---- Pagamento recebido, mas em análise (ex.: pago por um checkout antigo,
  // com valor diferente do atualizado) — nunca oferece pagar de novo aqui:
  // o dinheiro já foi recebido e está com a equipe pra conciliação manual.
  if (cobranca.status === 'revisao') {
    region.innerHTML = shell(`
      ${heroBlock()}
      <div class="public-card__body">
        ${infoPanel()}
        <div class="state-block" style="padding-top:24px;">
          <div class="state-block__icon" style="background:var(--blue-100);color:var(--blue-700);">${SB_ICON.clock}</div>
          <div class="state-block__title">Pagamento em análise</div>
          <p class="state-block__desc">Recebemos a confirmação do seu pagamento, mas o valor não corresponde ao valor atual desta cobrança. Isso não significa que o pagamento foi perdido — nossa equipe já foi notificada e vai entrar em contato para regularizar a diferença.</p>
        </div>
      </div>`);
    appendFooter();
    return;
  }

  // ---- Aviso discreto ANTES do vencimento (transparência exigida por lei:
  // a condição de atraso precisa ser informada antes de incidir) ----
  const avisoPreVencimento = cobranca.status !== 'atrasado' && cobranca.multaAtiva !== false ? `
    <div class="secure-note" style="margin-top:var(--space-5);text-align:center;">
      <span>Após o vencimento, poderão incidir multa de ${cobranca.multaPercent}% e juros de mora de ${cobranca.jurosPercentMes}% ao mês, calculados proporcionalmente aos dias de atraso.</span>
    </div>` : '';

  // ---- Painel de situação/encargos, no estilo "TMB", só quando vencida e
  // realmente com valor maior que o original ----
  const painelAtraso = temEncargos ? `
    <div class="auth-alert" style="margin-top:16px;flex-direction:column;align-items:stretch;gap:4px;">
      <strong style="display:flex;align-items:center;gap:8px;">${SB_ICON.alertTriangle}SITUAÇÃO DA COBRANÇA</strong>
      <span>Pagamento em atraso — vencida há ${cobranca.diasAtraso} ${cobranca.diasAtraso === 1 ? 'dia' : 'dias'}.</span>
    </div>

    <div class="public-card__panel" style="margin-top:12px;">
      <div class="public-section-title" style="margin-top:0;">Dados da cobrança</div>
      <div class="public-info-row"><span class="label">Valor original</span><span class="value">${SB_UI.formatCurrency(cobranca.valor)}</span></div>
      <div class="public-info-row"><span class="label">Vencimento</span><span class="value">${SB_UI.formatDate(cobranca.vencimento)}</span></div>
    </div>

    <div class="public-card__panel" style="margin-top:12px;">
      <div class="public-section-title" style="margin-top:0;">Encargos por atraso</div>
      <div class="public-info-row"><span class="label">Multa (${cobranca.multaPercent}%)</span><span class="value">${SB_UI.formatCurrency(cobranca.multaValor)}</span></div>
      <div class="public-info-row"><span class="label">Juros de mora (${cobranca.jurosPercentMes}% a.m.)</span><span class="value">${SB_UI.formatCurrency(cobranca.jurosValor)}</span></div>
    </div>

    <div class="public-card__panel" style="margin-top:12px;background:var(--gradient-brand-soft);">
      <div class="public-info-row" style="border-bottom:none;">
        <span class="label" style="font-weight:800;color:var(--text-primary);">Valor atualizado hoje</span>
        <span class="value" style="font-size:19px;">${SB_UI.formatCurrency(valorExibido)}</span>
      </div>
    </div>
    <p class="state-block__desc" style="margin-top:8px;">Valor atualizado até ${SB_UI.formatDate(cobranca.calculadoEm || new Date())}.</p>` : cobranca.status === 'atrasado' ? `
    <div class="auth-alert" style="margin-top:16px;">
      ${SB_ICON.alertTriangle}
      <span>Esta cobrança está vencida desde ${SB_UI.formatDate(cobranca.vencimento)}. Regularize o quanto antes.</span>
    </div>` : '';

  // ---- Payable state (pendente / atrasado) ----
  // Forma de pagamento e parcelamento são escolhidos pelo cliente dentro do
  // checkout da InfinitePay — nunca aqui. Mostrar/deixar escolher isso nesta
  // página prometeria algo que o clique em "Pagar agora" não cumpre (o
  // redirecionamento é sempre para o checkout_url já pronto, de qualquer forma).
  const hasCheckout = Boolean(cobranca.checkoutUrl);
  const isOverdue = cobranca.status === 'atrasado';

  region.innerHTML = shell(`
    ${heroBlock()}
    <div class="public-card__body">
      ${infoPanel()}
      ${painelAtraso}
      ${avisoPreVencimento}

      <div class="secure-note" style="margin-top:var(--space-5);">
        ${SB_ICON.wallet}
        <span>Formas de pagamento disponíveis no checkout</span>
      </div>

      <button class="btn btn-primary btn-block pay-btn-fixed" id="pay-btn">
        <span id="pay-btn-label">Pagar agora · ${SB_UI.formatCurrency(valorExibido)}</span>
      </button>

      <div class="secure-note">
        ${SB_ICON.shield}
        <span>Ambiente seguro · Pagamento criptografado</span>
      </div>
    </div>
  `);
  appendFooter();

  const payBtn = document.getElementById('pay-btn');
  const payBtnLabel = document.getElementById('pay-btn-label');

  function goToCheckout(url) {
    if (!isTrustedCheckoutUrl(url)) {
      SB_UI.toast({ type: 'error', title: 'Não foi possível abrir o pagamento', desc: 'Tente novamente em instantes.' });
      return;
    }
    // Redireciona para o Checkout Integrado real da InfinitePay.
    window.location.href = url;
  }

  payBtn.addEventListener('click', async () => {
    // Cobrança vencida: o checkout_url já carregado pode ter sido gerado
    // com o valor original (sem multa/juros) — nunca reaproveita direto.
    // O servidor recalcula e trava o valor de hoje antes de gerar um link
    // novo (create-checkout-for-token / resolveChargeCheckoutUrl).
    if (isOverdue) {
      payBtn.disabled = true;
      const originalLabel = payBtnLabel.textContent;
      payBtnLabel.textContent = 'Calculando valor atualizado…';
      try {
        const result = await DB.cobrancas.gerarCheckoutAtualizado(token);
        if (result?.success && result.checkout_url) {
          goToCheckout(result.checkout_url);
          return;
        }
        SB_UI.toast({
          type: 'error',
          title: 'Não foi possível gerar o pagamento atualizado',
          desc: result?.message || 'Tente novamente em instantes ou entre em contato com quem emitiu a cobrança.',
          duration: 5500,
        });
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Não foi possível gerar o pagamento atualizado', desc: 'Tente novamente em instantes.' });
      } finally {
        payBtn.disabled = false;
        payBtnLabel.textContent = originalLabel;
      }
      return;
    }

    if (!hasCheckout) {
      SB_UI.toast({
        type: 'info',
        title: 'O link de pagamento ainda não foi gerado.',
        desc: 'Tente novamente em instantes ou entre em contato com quem emitiu a cobrança.',
        duration: 5000,
      });
      return;
    }
    goToCheckout(cobranca.checkoutUrl);
  });
})();
