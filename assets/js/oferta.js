/* ==========================================================================
   Smart Billing — Página pública da oferta de planos
   --------------------------------------------------------------------------
   Acessível sem login, via ?token=<public_token> de plan_offers. Nunca
   confia em preço/desconto/duração vindos do próprio HTML/JS desta página —
   eles só existem aqui para EXIBIÇÃO (já vieram prontos do banco via
   get_public_plan_offer_by_token). Ao clicar em "Escolher plano", o único
   dado enviado ao servidor é o id do plano — o servidor (Edge Function
   select-plan-offer + RPC select_plan_offer) recalcula tudo de novo a
   partir de billing_plans antes de criar qualquer cobrança.
   ========================================================================== */

(async function initOferta() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const region = document.getElementById('offer-region');

  // Mesma lista/checagem de cobranca-publica.js (host EXATO, nunca
  // includes/substring) — duplicada aqui de propósito, seguindo o mesmo
  // padrão já usado nas outras páginas públicas do projeto (cada página
  // pública é um script isolado, sem um módulo de utilitários compartilhado
  // entre elas).
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

  function stateShell(inner) {
    region.innerHTML = `
      <div class="offer-header">
        <img class="offer-header__logo" src="assets/img/logo.png" alt="Smart Billing" />
      </div>
      <div class="offer-state-card">${inner}</div>`;
  }

  function errorState(title, desc) {
    stateShell(`
      <div style="padding:48px 24px;">
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">${title}</div>
          <p class="state-block__desc">${desc}</p>
        </div>
      </div>`);
  }

  if (!token) { errorState('Oferta não encontrada', 'O link acessado é inválido ou está incompleto.'); return; }

  let oferta;
  try {
    oferta = await DB.ofertas.getByPublicToken(token);
  } catch (err) {
    errorState('Erro ao carregar oferta', 'Não foi possível buscar os dados. Tente novamente em instantes.');
    return;
  }

  if (!oferta) { errorState('Oferta não encontrada', 'O link acessado é inválido ou a oferta foi removida.'); return; }

  document.title = `Escolha seu plano · ${oferta.empresaNome || 'Smart Billing'}`;

  // ---- Expirada ----
  if (oferta.status === 'active' && oferta.isExpired) {
    stateShell(`
      <div style="padding:48px 24px;">
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.clock}</div>
          <div class="state-block__title">Esta oferta expirou</div>
          <p class="state-block__desc">Entre em contato com ${SB_UI.escapeHtml(oferta.empresaNome || 'a empresa')} para receber um novo link.</p>
        </div>
      </div>`);
    return;
  }

  // ---- Cancelada ----
  if (oferta.status === 'cancelled') {
    errorState('Oferta indisponível', 'Este link não está mais disponível.');
    return;
  }

  // ---- Já selecionada ----
  if (oferta.status === 'selected') {
    const pago = oferta.cobrancaStatus === 'paid';
    const cancelada = oferta.cobrancaStatus === 'cancelled';
    stateShell(`
      <div style="padding:48px 24px;">
        <div class="state-block ${pago ? '' : ''}">
          <div class="state-block__icon" style="background:${pago ? 'var(--green-100)' : 'var(--amber-100)'};color:${pago ? 'var(--green-700)' : 'var(--amber-700)'};">
            ${pago ? SB_ICON.checkCircle : SB_ICON.clock}
          </div>
          <div class="state-block__title">Plano já escolhido</div>
          <p class="state-block__desc">
            ${oferta.planoSelecionadoNome ? `Você escolheu o plano <strong>${SB_UI.escapeHtml(oferta.planoSelecionadoNome)}</strong>. ` : ''}
            ${pago ? 'Pagamento confirmado — obrigado!' : cancelada ? 'A cobrança deste plano foi cancelada. Entre em contato para gerar uma nova.' : 'Aguardando confirmação do pagamento.'}
          </p>
          ${!pago && !cancelada && oferta.cobrancaPublicToken ? `<a class="btn btn-primary" style="margin-top:12px;" href="cobranca-publica.html?token=${oferta.cobrancaPublicToken}">Ver cobrança</a>` : ''}
        </div>
      </div>`);
    return;
  }

  // ---- Estado normal: oferecer os planos ----
  const TIPO_LABEL = { one_time: 'pagamento único', recurring_monthly: 'cobrança mensal' };

  function moneyPerMonth(p) {
    if (p.tipoCobranca === 'recurring_monthly') return null;
    if (!p.duracaoMeses || p.duracaoMeses <= 1) return null;
    return p.valor / p.duracaoMeses;
  }

  function planCardHtml(p) {
    const equivalente = moneyPerMonth(p);
    const economia = p.valorReferencia != null ? p.valorReferencia - p.valor : null;
    return `
      <div class="plan-card ${p.destaque ? 'plan-card--featured' : ''}" data-plan-id="${p.id}">
        ${p.badge ? `<span class="plan-card__badge">${SB_UI.escapeHtml(p.badge)}</span>` : ''}
        <div class="plan-card__name">${SB_UI.escapeHtml(p.nome)}</div>
        ${p.descontoPercent > 0 ? `<div class="plan-card__discount">${p.descontoPercent}% OFF</div>` : ''}
        ${p.valorReferencia != null ? `<div class="plan-card__reference">${SB_UI.formatCurrency(p.valorReferencia)}</div>` : ''}
        <div class="plan-card__price">${SB_UI.formatCurrency(p.valor)}${p.tipoCobranca === 'recurring_monthly' ? '<span>/mês</span>' : ''}</div>
        ${equivalente != null ? `<div class="plan-card__equivalent">equivale a ${SB_UI.formatCurrency(equivalente)}/mês</div>` : ''}
        ${economia != null && economia > 0 ? `<div class="plan-card__savings">Economize ${SB_UI.formatCurrency(economia)}</div>` : ''}
        ${p.descricaoCurta ? `<div class="plan-card__desc">${SB_UI.escapeHtml(p.descricaoCurta)}</div>` : `<div class="plan-card__desc">${TIPO_LABEL[p.tipoCobranca] || ''}</div>`}
        <div class="plan-card__cta">
          <button type="button" class="btn ${p.destaque ? 'btn-primary' : 'btn-secondary'} btn-block" data-choose="${p.id}">
            Escolher ${SB_UI.escapeHtml(p.nome).toLowerCase()}
          </button>
        </div>
      </div>`;
  }

  if (!oferta.planos || oferta.planos.length === 0) {
    errorState('Nenhum plano disponível', 'Esta oferta não tem planos ativos no momento. Entre em contato para receber um novo link.');
    return;
  }

  region.innerHTML = `
    <div class="offer-header">
      <img class="offer-header__logo" src="assets/img/logo.png" alt="Smart Billing" />
      ${oferta.clienteNome ? `<div class="offer-header__greeting">Olá, ${SB_UI.escapeHtml(oferta.clienteNome)}! 👋</div>` : ''}
      <div class="offer-header__title">${oferta.titulo ? SB_UI.escapeHtml(oferta.titulo) : 'Escolha o plano ideal'}</div>
      <div class="offer-header__subtitle">Mais tempo, mais economia</div>
      ${oferta.mensagem ? `<div class="offer-header__message">${SB_UI.escapeHtml(oferta.mensagem)}</div>` : ''}
    </div>
    <div class="plan-grid">${oferta.planos.map(planCardHtml).join('')}</div>
    <div class="public-footer-logo">
      <img class="public-footer-logo__wordmark" src="assets/img/logo.png" alt="Smart Billing" />
    </div>`;

  let processing = false;
  region.querySelectorAll('[data-choose]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (processing) return;
      processing = true;
      const planId = btn.dataset.choose;
      const originalLabel = btn.innerHTML;
      region.querySelectorAll('[data-choose]').forEach((b) => { b.disabled = true; });
      btn.innerHTML = 'Processando…';

      let result;
      try {
        result = await DB.ofertas.selectPlan({ offerToken: token, planId });
      } catch (err) {
        result = { success: false, message: 'Não foi possível processar sua escolha. Tente novamente.' };
      }

      if (!result || !result.success) {
        const msg = result?.result === 'expired'
          ? 'Esta oferta expirou.'
          : result?.result === 'invalid_plan'
            ? 'Este plano não está mais disponível.'
            : (result?.message || 'Não foi possível processar sua escolha. Tente novamente.');
        SB_UI.toast({ type: 'error', title: 'Não foi possível continuar', desc: msg });
        btn.innerHTML = originalLabel;
        region.querySelectorAll('[data-choose]').forEach((b) => { b.disabled = false; });
        processing = false;
        return;
      }

      if (result.checkout_url && isTrustedCheckoutUrl(result.checkout_url)) {
        window.location.href = result.checkout_url;
        return;
      }

      if (result.charge_public_token) {
        window.location.href = `cobranca-publica.html?token=${result.charge_public_token}`;
        return;
      }

      SB_UI.toast({ type: 'error', title: 'Não foi possível abrir o pagamento', desc: 'Tente novamente em instantes.' });
      btn.innerHTML = originalLabel;
      region.querySelectorAll('[data-choose]').forEach((b) => { b.disabled = false; });
      processing = false;
    });
  });
})();
