/* ==========================================================================
   Smart Billing — Notificações do topbar
   --------------------------------------------------------------------------
   Não existe uma tabela dedicada de notificações no banco, então a lista é
   derivada das cobranças reais (pagamentos recebidos, cobranças atrasadas e
   vencendo em breve) — nunca usa dados fictícios/demo.

   Carregado de forma independente pelo layout.js (assets/js/layout.js →
   loadNotifications()): qualquer falha aqui fica isolada e nunca impede a
   sidebar, o topbar ou o restante da página de aparecer.
   ========================================================================== */

window.SB_NOTIFICATIONS = (() => {
  let items = [];

  function toneColor(tone) {
    if (tone === 'success') return 'var(--green-500)';
    if (tone === 'warn') return 'var(--amber-500)';
    return 'var(--red-500)';
  }

  function emptyHtml() {
    return `<div class="action-menu__item" style="cursor:default;color:var(--text-muted);font-size:12.5px;">Nenhuma notificação no momento</div>`;
  }

  function itemsHtml(list) {
    return list.map((n) => `
      <div class="action-menu__item" style="align-items:flex-start;cursor:default;">
        <span style="width:8px;height:8px;border-radius:50%;margin-top:5px;flex-shrink:0;background:${toneColor(n.tone)}"></span>
        <span style="display:flex;flex-direction:column;gap:2px;">
          <span style="font-weight:700;color:var(--text-primary);">${n.title}</span>
          <span style="font-size:11.5px;color:var(--text-muted);font-weight:500;">${n.desc}</span>
          <span style="font-size:10.5px;color:var(--text-muted);">${n.time}</span>
        </span>
      </div>`).join('<div class="action-menu__divider"></div>');
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (diffMin < 1) return 'agora mesmo';
    if (diffMin < 60) return `há ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `há ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    return `há ${diffD} dia${diffD > 1 ? 's' : ''}`;
  }

  async function fetchFromCharges() {
    if (typeof DB === 'undefined') return [];
    const recent = await DB.dashboard.recent(20);
    const now = Date.now();
    const notifs = [];

    recent.forEach((c) => {
      const nome = c.cliente?.nome || 'Cliente';
      if (c.status === 'pago' && c.pagoEm) {
        notifs.push({ tone: 'success', title: 'Pagamento recebido', desc: `${nome} pagou ${SB_UI.formatCurrency(c.valor)}`, when: c.pagoEm });
      } else if (c.status === 'atrasado') {
        notifs.push({ tone: 'danger', title: 'Cobrança atrasada', desc: `${nome} está com pagamento atrasado`, when: c.vencimento });
      } else if (c.status === 'pendente') {
        const dias = (new Date(c.vencimento) - now) / 86400000;
        if (dias >= 0 && dias <= 7) {
          notifs.push({ tone: 'warn', title: 'Cobrança vencendo', desc: `${nome} vence em ${Math.max(1, Math.ceil(dias))} dia(s)`, when: c.vencimento });
        }
      }
    });

    return notifs
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, 3)
      .map((n) => ({ ...n, time: relativeTime(n.when) }));
  }

  function render(listEl) {
    if (!listEl) return;
    listEl.innerHTML = items.length ? itemsHtml(items) : emptyHtml();
  }

  function renderBadge(dotEl) {
    if (!dotEl) return;
    dotEl.style.display = items.length ? '' : 'none';
  }

  // Ponto de entrada chamado pelo layout.js. Recebe os elementos já
  // montados no DOM e nunca lança — qualquer erro vira estado vazio.
  async function init({ listEl, dotEl } = {}) {
    try {
      items = await fetchFromCharges();
    } catch (err) {
      console.warn('[Smart Billing] notifications: falha ao buscar dados —', err?.message || err);
      items = [];
    }
    render(listEl);
    renderBadge(dotEl);
  }

  function getUnreadCount() {
    return items.length;
  }

  return { init, getUnreadCount };
})();
