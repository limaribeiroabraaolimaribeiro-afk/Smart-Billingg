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

  const brandHtml = `
    <div class="offer-brand">
      <img class="offer-brand__icon" src="assets/img/logo.svg" alt="" />
      <span class="offer-brand__text">Smart <strong>Billing</strong></span>
    </div>`;

  function stateShell(inner) {
    region.innerHTML = `
      <div class="offer-header">${brandHtml}</div>
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
  function moneyPerMonth(p) {
    if (p.tipoCobranca === 'recurring_monthly') return null;
    if (!p.duracaoMeses || p.duracaoMeses <= 1) return null;
    return p.valor / p.duracaoMeses;
  }

  // Hierarquia visual dinâmica (não depende do texto do badge, só de campos
  // já existentes): plano com destaque=true vira o card de ouro/featured;
  // qualquer outro plano com badge preenchido vira o card roxo/accent; sem
  // badge, card neutro — mesma lógica pra 1, 2, 3 ou 4 planos.
  function planCardHtml(p) {
    const equivalente = moneyPerMonth(p);
    const economia = p.valorReferencia != null ? p.valorReferencia - p.valor : null;
    const isFeatured = !!p.destaque;
    const isAccent = !isFeatured && Boolean(p.badge);
    const tone = isFeatured ? 'featured' : isAccent ? 'accent' : 'default';
    const hasRows = equivalente != null || (economia != null && economia > 0);

    const badgeIcon = isFeatured ? SB_ICON.star : SB_ICON.diamond;

    return `
      <div class="offer-plan-card ${isFeatured ? 'offer-plan-card--featured' : isAccent ? 'offer-plan-card--accent' : ''}" data-plan-id="${p.id}">
        ${p.badge ? `<span class="offer-plan-card__badge offer-plan-card__badge--${isFeatured ? 'gold' : 'purple'}">${badgeIcon}${SB_UI.escapeHtml(p.badge)}</span>` : ''}
        <div class="offer-plan-card__icon">${SB_ICON.calendar}</div>
        <div class="offer-plan-card__name">${SB_UI.escapeHtml(p.nome)}</div>
        ${p.descontoPercent > 0 ? `<div class="offer-plan-card__discount">${p.descontoPercent}% OFF</div>` : ''}
        <div class="offer-plan-card__price-block">
          ${p.valorReferencia != null ? `<div class="offer-plan-card__reference">${SB_UI.formatCurrency(p.valorReferencia)}</div>` : ''}
          <div class="offer-plan-card__price">${SB_UI.formatCurrency(p.valor)}${p.tipoCobranca === 'recurring_monthly' ? '<span>/mês</span>' : ''}</div>
        </div>
        ${hasRows ? `
          <div class="offer-plan-card__rows">
            ${equivalente != null ? `<div class="offer-plan-card__row"><span class="offer-plan-card__row-icon">${SB_ICON.trendUp}</span><span>equivale a <strong>${SB_UI.formatCurrency(equivalente)}/mês</strong></span></div>` : ''}
            ${economia != null && economia > 0 ? `<div class="offer-plan-card__row"><span class="offer-plan-card__row-icon">${SB_ICON.wallet}</span><span>Economize <strong>${SB_UI.formatCurrency(economia)}</strong></span></div>` : ''}
            ${p.descricaoCurta ? `<div class="offer-plan-card__row"><span class="offer-plan-card__row-icon">${SB_ICON.checkCircle}</span><span>${SB_UI.escapeHtml(p.descricaoCurta)}</span></div>` : ''}
          </div>` : p.descricaoCurta ? `
          <div class="offer-plan-card__desc-solo">
            <span class="offer-plan-card__row-icon">${SB_ICON.checkCircle}</span>
            <span>${SB_UI.escapeHtml(p.descricaoCurta)}</span>
          </div>` : ''}
        <div class="offer-plan-card__cta">
          <button type="button" class="offer-plan-card__btn offer-plan-card__btn--${tone}" data-choose="${p.id}">
            Escolher ${SB_UI.escapeHtml(p.nome).toLowerCase()}
          </button>
        </div>
      </div>`;
  }

  if (!oferta.planos || oferta.planos.length === 0) {
    errorState('Nenhum plano disponível', 'Esta oferta não tem planos ativos no momento. Entre em contato para receber um novo link.');
    return;
  }

  const tituloHtml = oferta.titulo
    ? `<span class="offer-header__title-line1">${SB_UI.escapeHtml(oferta.titulo)}</span>`
    : `<span class="offer-header__title-line1">Escolha o</span><span class="offer-header__title-line2">plano ideal</span>`;
  const tagline = oferta.mensagem || 'Escolha a opção que melhor combina com você. Quanto maior o período, maior a economia.';
  const gridCount = Math.min(Math.max(oferta.planos.length, 1), 4);

  region.innerHTML = `
    <div class="offer-header">
      ${brandHtml}
      ${oferta.clienteNome ? `<div class="offer-header__greeting">Olá, ${SB_UI.escapeHtml(oferta.clienteNome)}! 👋</div>` : ''}
      <div class="offer-header__title">${tituloHtml}</div>
      <div class="offer-header__subtitle">Mais tempo, mais economia</div>
      <div class="offer-header__message">${SB_UI.escapeHtml(tagline)}</div>
    </div>
    <div class="offer-plan-grid" data-count="${gridCount}">${oferta.planos.map(planCardHtml).join('')}</div>
    <div class="offer-footer-note">${SB_ICON.shield}<span>Formas de pagamento disponíveis no checkout.</span></div>
    <div class="offer-brand offer-brand--footer">
      <img class="offer-brand__icon" src="assets/img/logo.svg" alt="" />
      <span class="offer-brand__text">Smart <strong>Billing</strong></span>
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
