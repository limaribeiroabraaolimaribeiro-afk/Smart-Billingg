/* ==========================================================================
   Smart Billing — Relatórios page logic
   ========================================================================== */

(async function initRelatorios() {
  await SBLayout.mount({
    active: 'relatorios',
    title: 'Relatórios',
    breadcrumb: 'Painel <span>/</span> Relatórios',
  });

  const STATUS_COLOR = {
    pago: 'var(--green-500)',
    pendente: 'var(--amber-500)',
    atrasado: 'var(--red-500)',
    cancelado: 'var(--gray-500)',
  };

  function ensureTooltip() {
    let tip = document.querySelector('.chart-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tooltip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  function wireTooltip(el, text) {
    const tip = ensureTooltip();
    el.addEventListener('mousemove', (e) => {
      tip.textContent = text;
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY - 12}px`;
      tip.classList.add('is-visible');
    });
    el.addEventListener('mouseleave', () => tip.classList.remove('is-visible'));
  }

  function renderStats(cobrancas) {
    const pagas = cobrancas.filter((c) => c.status === 'pago');
    const totalRecebido = pagas.reduce((s, c) => s + c.valor, 0);
    const ticketMedio = pagas.length ? totalRecebido / pagas.length : 0;
    const naoCanceladas = cobrancas.filter((c) => c.status !== 'cancelado');
    const atrasadas = cobrancas.filter((c) => c.status === 'atrasado');
    const inadimplencia = naoCanceladas.length ? (atrasadas.length / naoCanceladas.length) * 100 : 0;

    document.getElementById('report-stats').innerHTML = `
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon stat-card__icon--brand">${SB_ICON.wallet}</span></div>
        <div><div class="stat-card__label">Total recebido (histórico)</div><div class="stat-card__value">${SB_UI.formatCurrency(totalRecebido)}</div><div class="stat-card__count">${pagas.length} cobranças pagas</div></div>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon stat-card__icon--blue">${SB_ICON.chart}</span></div>
        <div><div class="stat-card__label">Ticket médio</div><div class="stat-card__value">${SB_UI.formatCurrency(ticketMedio)}</div><div class="stat-card__count">por cobrança paga</div></div>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon stat-card__icon--red">${SB_ICON.alertTriangle}</span></div>
        <div><div class="stat-card__label">Taxa de inadimplência</div><div class="stat-card__value">${inadimplencia.toFixed(1)}%</div><div class="stat-card__count">${atrasadas.length} cobranças atrasadas</div></div>
      </div>`;
  }

  function renderChart(pagamentos) {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('pt-BR', { month: 'short' }), total: 0 });
    }
    pagamentos.forEach((p) => {
      const d = new Date(p.dataHora);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const m = months.find((x) => x.key === key);
      if (m) m.total += p.valor;
    });

    const max = Math.max(...months.map((m) => m.total), 1);
    const region = document.getElementById('chart-region');

    if (pagamentos.length === 0) {
      region.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.chart}</div>
          <div class="state-block__title">Sem dados suficientes</div>
          <p class="state-block__desc">Assim que cobranças forem pagas, o gráfico de faturamento aparecerá aqui.</p>
        </div>`;
      return;
    }

    region.innerHTML = `
      <div class="bar-chart">
        ${months.map((m) => `
          <div class="bar-chart__col">
            <div class="bar-chart__track">
              <div class="bar-chart__fill" data-tip="${SB_UI.escapeHtml(m.label)}: ${SB_UI.formatCurrency(m.total)}" style="height:${Math.max((m.total / max) * 100, m.total > 0 ? 4 : 0)}%;"></div>
            </div>
            <span class="bar-chart__label">${SB_UI.escapeHtml(m.label)}</span>
          </div>`).join('')}
      </div>`;

    region.querySelectorAll('.bar-chart__fill').forEach((el) => wireTooltip(el, el.dataset.tip));
  }

  function renderStatus(cobrancas) {
    const region = document.getElementById('status-region');
    const order = ['pago', 'pendente', 'atrasado', 'cancelado'];
    const labels = { pago: 'Pago', pendente: 'Pendente', atrasado: 'Atrasado', cancelado: 'Cancelado' };
    const total = cobrancas.length;

    if (total === 0) {
      region.innerHTML = `<div class="state-block"><div class="state-block__icon">${SB_ICON.inbox}</div><div class="state-block__title">Nenhuma cobrança cadastrada</div></div>`;
      return;
    }

    const counts = order.map((status) => ({
      status, count: cobrancas.filter((c) => c.status === status).length,
    }));

    region.innerHTML = `
      <div class="status-bar">
        ${counts.map((c) => c.count > 0 ? `<div class="status-bar__seg" data-tip="${labels[c.status]}: ${c.count}" style="width:${(c.count / total) * 100}%;background:${STATUS_COLOR[c.status]};"></div>` : '').join('')}
      </div>
      <div class="status-legend">
        ${counts.map((c) => `
          <div class="status-legend__row">
            <span class="status-legend__dot" style="background:${STATUS_COLOR[c.status]};"></span>
            <span class="status-legend__label">${labels[c.status]}</span>
            <span class="status-legend__value">${c.count} · ${((c.count / total) * 100).toFixed(0)}%</span>
          </div>`).join('')}
      </div>`;

    region.querySelectorAll('.status-bar__seg').forEach((el) => wireTooltip(el, el.dataset.tip));
  }

  function renderTopClients(clientes) {
    const region = document.getElementById('top-clients-region');
    const top = [...clientes].filter((c) => c.totalRecebido > 0).sort((a, b) => b.totalRecebido - a.totalRecebido).slice(0, 5);

    if (top.length === 0) {
      region.innerHTML = `<div class="state-block"><div class="state-block__icon">${SB_ICON.users}</div><div class="state-block__title">Nenhum recebimento ainda</div></div>`;
      return;
    }

    region.innerHTML = top.map((c, i) => `
      <div class="rank-row">
        <span class="rank-row__num">${i + 1}</span>
        <span class="rank-row__name">${SB_UI.escapeHtml(c.nome)}</span>
        <span class="rank-row__value">${SB_UI.formatCurrency(c.totalRecebido)}</span>
      </div>`).join('');
  }

  try {
    const [cobrancas, pagamentos, clientes] = await Promise.all([
      DB.cobrancas.list(),
      DB.pagamentos.list(),
      DB.clientes.listWithStats(),
    ]);
    renderStats(cobrancas);
    renderChart(pagamentos);
    renderStatus(cobrancas);
    renderTopClients(clientes);
  } catch (err) {
    document.getElementById('report-stats').innerHTML = '';
    document.getElementById('chart-region').innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar os relatórios</div>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`;
  }
})();
