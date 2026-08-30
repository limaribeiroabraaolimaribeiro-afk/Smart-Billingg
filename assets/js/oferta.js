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

  if (!oferta.planos || oferta.planos.length === 0) {
    errorState('Nenhum plano disponível', 'Esta oferta não tem planos ativos no momento. Entre em contato para receber um novo link.');
    return;
  }

  // ------------------------------------------------------------------------
  // Papel comercial de cada plano — nunca pelo nome, só por billing_type/
  // duration_months/destaque. A composição visual (Mensal esquerda, Anual
  // centro/dourado, Semestral direita, qualquer outra duração como oferta
  // secundária abaixo) é uma decisão de marketing fixa, independente de
  // quantos planos existirem ou da ordem em que vieram do banco. A página
  // se adapta aos planos que realmente existem — nenhuma duração além de
  // mensal/anual/semestral tem posição obrigatória (inclusive 24 meses, que
  // agora cai em "secundário" como qualquer outra duração não mapeada).
  //   recurring_monthly           -> mensal (esquerda)
  //   destaque=true, senão dur=12 -> anual (centro, protagonista)
  //   duration_months=6           -> semestral (direita)
  //   qualquer outro              -> secundário (faixa abaixo)
  // ------------------------------------------------------------------------
  function classificarPlanos(planos) {
    const usados = new Set();
    const mensal = planos.find((p) => p.tipoCobranca === 'recurring_monthly' && !usados.has(p.id));
    if (mensal) usados.add(mensal.id);
    let anual = planos.find((p) => p.destaque && !usados.has(p.id));
    if (!anual) anual = planos.find((p) => p.duracaoMeses === 12 && !usados.has(p.id));
    if (anual) usados.add(anual.id);
    const semestral = planos.find((p) => p.duracaoMeses === 6 && !usados.has(p.id));
    if (semestral) usados.add(semestral.id);
    const secundarios = planos.filter((p) => !usados.has(p.id));
    return { mensal, anual, semestral, secundarios };
  }

  // Preço muito grande (clamp) mas que precisa caber no card sempre — o
  // tamanho recua conforme o texto formatado fica mais comprido (R$ 190 vs
  // R$ 12.345,00), calculado a partir do valor real, nunca de uma lista
  // fixa de planos.
  function priceSizeClass(formatted) {
    const len = formatted.replace(/\s/g, '').length;
    if (len <= 9) return 'is-price-lg';
    if (len <= 11) return 'is-price-md';
    return 'is-price-sm';
  }

  function rowsHtml(p) {
    const equivalente = moneyPerMonth(p);
    const economia = p.valorReferencia != null ? p.valorReferencia - p.valor : null;
    const linhas = [
      equivalente != null ? `<div class="offer-plan-card__row"><span class="offer-plan-card__row-icon">${SB_ICON.trendUp}</span><span>equivale a <strong>${SB_UI.formatCurrency(equivalente)}/mês</strong></span></div>` : '',
      economia != null && economia > 0 ? `<div class="offer-plan-card__row"><span class="offer-plan-card__row-icon">${SB_ICON.wallet}</span><span>Economize <strong>${SB_UI.formatCurrency(economia)}</strong></span></div>` : '',
    ].filter(Boolean);
    if (!linhas.length) return '';
    return `<div class="offer-plan-card__rows">${linhas.join('')}</div>`;
  }

  // Cards principais: Mensal (neutro) / Anual (dourado, protagonista) /
  // Semestral (roxo) — a cor é fixa por papel, não depende de badge/destaque
  // (só o Anual usa destaque para decidir QUEM ocupa o centro).
  function heroCardHtml(p, role) {
    const tone = role === 'anual' ? 'featured' : role === 'semestral' ? 'accent' : 'default';
    const precoFormatado = SB_UI.formatCurrency(p.valor);
    const badgeIcon = role === 'anual' ? SB_ICON.star : SB_ICON.diamond;
    return `
      <div class="offer-plan-card offer-plan-card--${tone}" data-role="${role}" data-plan-id="${p.id}">
        ${p.badge ? `<span class="offer-plan-card__badge offer-plan-card__badge--${role === 'anual' ? 'gold' : 'purple'}">${badgeIcon}${SB_UI.escapeHtml(p.badge)}</span>` : ''}
        <div class="offer-plan-card__icon">${SB_ICON.calendar}</div>
        <div class="offer-plan-card__name">${SB_UI.escapeHtml(p.nome)}</div>
        ${p.descontoPercent > 0 ? `<div class="offer-plan-card__discount">${p.descontoPercent}% OFF</div>` : ''}
        <div class="offer-plan-card__price-block">
          ${p.valorReferencia != null ? `<div class="offer-plan-card__reference">${SB_UI.formatCurrency(p.valorReferencia)}</div>` : ''}
          <div class="offer-plan-card__price ${priceSizeClass(precoFormatado)}">${precoFormatado}${p.tipoCobranca === 'recurring_monthly' ? '<span>/mês</span>' : ''}</div>
        </div>
        ${rowsHtml(p)}
        ${role === 'mensal' && p.descricaoCurta ? `
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

  // Faixa secundária (ex.: Semestral) — não compete visualmente com o
  // Anual: um único indicador de desconto (nunca badge + pill repetindo o
  // mesmo "10% OFF"), CTA discreto, layout horizontal no desktop.
  function secondaryBannerHtml(p) {
    const precoFormatado = SB_UI.formatCurrency(p.valor);
    return `
      <div class="offer-secondary" data-role="secundario" data-plan-id="${p.id}">
        <div class="offer-secondary__intro">
          <span class="offer-secondary__question">Quer economizar sem fechar um ano?</span>
          <span class="offer-secondary__name">${SB_UI.escapeHtml(p.nome)}</span>
          ${p.descontoPercent > 0 ? `<span class="offer-secondary__discount">${p.descontoPercent}% OFF</span>` : ''}
        </div>
        <div class="offer-secondary__price-block">
          ${p.valorReferencia != null ? `<span class="offer-secondary__reference">${SB_UI.formatCurrency(p.valorReferencia)}</span>` : ''}
          <span class="offer-secondary__price">${precoFormatado}</span>
        </div>
        ${rowsHtml(p).replace('offer-plan-card__rows', 'offer-plan-card__rows offer-secondary__rows')}
        <div class="offer-secondary__cta">
          <button type="button" class="offer-plan-card__btn offer-plan-card__btn--accent" data-choose="${p.id}">
            Escolher ${SB_UI.escapeHtml(p.nome).toLowerCase()}
          </button>
        </div>
      </div>`;
  }

  const { mensal, anual, semestral, secundarios } = classificarPlanos(oferta.planos);

  if (!mensal && !anual && !semestral && secundarios.length === 0) {
    errorState('Nenhum plano disponível', 'Esta oferta não tem planos ativos no momento. Entre em contato para receber um novo link.');
    return;
  }

  const tituloHtml = oferta.titulo
    ? `<span class="offer-header__title-line1">${SB_UI.escapeHtml(oferta.titulo)}</span>`
    : `<span class="offer-header__title-line1">Escolha o</span><span class="offer-header__title-line2">plano ideal</span>`;
  const tagline = oferta.mensagem || 'Escolha a opção que melhor combina com você. Quanto maior o período, maior a economia.';

  region.innerHTML = `
    <div class="offer-header">
      ${brandHtml}
      ${oferta.clienteNome ? `<div class="offer-header__greeting">Olá, ${SB_UI.escapeHtml(oferta.clienteNome)}! 👋</div>` : ''}
      <div class="offer-header__title">${tituloHtml}</div>
      <div class="offer-header__subtitle">Mais tempo, mais economia</div>
      <div class="offer-header__message">${SB_UI.escapeHtml(tagline)}</div>
    </div>
    <div class="offer-hero-row">
      ${mensal ? heroCardHtml(mensal, 'mensal') : ''}
      ${anual ? heroCardHtml(anual, 'anual') : ''}
      ${semestral ? heroCardHtml(semestral, 'semestral') : ''}
      ${secundarios.map(secondaryBannerHtml).join('')}
    </div>
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
