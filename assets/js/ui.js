/* ==========================================================================
   Smart Billing — UI helpers (format, toasts, modal, icons)
   ========================================================================== */

const SB_UI = (() => {
  function formatCurrency(value) {
    return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function formatDate(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    return d.toLocaleDateString('pt-BR');
  }

  function formatDateTime(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
  }

  function statusMeta(status) {
    const map = {
      pago: { label: 'Pago', cls: 'badge-paid' },
      pendente: { label: 'Pendente', cls: 'badge-pending' },
      atrasado: { label: 'Atrasado', cls: 'badge-overdue' },
      cancelado: { label: 'Cancelado', cls: 'badge-canceled' },
    };
    return map[status] || { label: status, cls: 'badge-canceled' };
  }

  function badgeHtml(status) {
    const meta = statusMeta(status);
    return `<span class="badge ${meta.cls}">${meta.label}</span>`;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Toasts ----------
  function ensureToastStack() {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  };

  function toast({ type = 'info', title, desc = '', duration = 4200 }) {
    const stack = ensureToastStack();
    const el = document.createElement('div');
    el.className = `toast is-${type}`;
    el.innerHTML = `
      <div class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</div>
      <div class="toast-body">
        <div class="toast-title">${escapeHtml(title)}</div>
        ${desc ? `<div class="toast-desc">${escapeHtml(desc)}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="Fechar notificação">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>`;
    el.querySelector('.toast-close').addEventListener('click', () => el.remove());
    stack.appendChild(el);
    if (duration) setTimeout(() => el.remove(), duration);
    return el;
  }

  // ---------- Confirm modal ----------
  function ensureModalRoot() {
    let root = document.querySelector('.modal-overlay[data-role="confirm"]');
    if (!root) {
      root = document.createElement('div');
      root.className = 'modal-overlay';
      root.dataset.role = 'confirm';
      root.innerHTML = `
        <div class="modal" role="alertdialog" aria-modal="true">
          <div class="modal-icon"></div>
          <div>
            <div class="modal-title"></div>
            <p class="modal-desc"></p>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-action="cancel">Cancelar</button>
            <button class="btn btn-danger" data-action="confirm">Confirmar</button>
          </div>
        </div>`;
      document.body.appendChild(root);
    }
    return root;
  }

  const CONFIRM_ICONS = {
    danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  };

  function confirmDialog({ title, desc, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', tone = 'danger' }) {
    const root = ensureModalRoot();
    root.querySelector('.modal-icon').className = `modal-icon is-${tone}`;
    root.querySelector('.modal-icon').innerHTML = CONFIRM_ICONS[tone] || CONFIRM_ICONS.danger;
    root.querySelector('.modal-title').textContent = title;
    root.querySelector('.modal-desc').textContent = desc;
    const confirmBtn = root.querySelector('[data-action="confirm"]');
    const cancelBtn = root.querySelector('[data-action="cancel"]');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    cancelBtn.textContent = cancelLabel;

    return new Promise((resolve) => {
      root.classList.add('is-open');
      const cleanup = (result) => {
        root.classList.remove('is-open');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        root.removeEventListener('click', onOverlay);
        resolve(result);
      };
      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onOverlay = (e) => { if (e.target === root) cleanup(false); };
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      root.addEventListener('click', onOverlay);
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.style.position = 'fixed';
    tmp.style.opacity = '0';
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
    return Promise.resolve();
  }

  function whatsappLink(phone, message) {
    const digits = String(phone || '').replace(/\D/g, '');
    const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
    return `https://wa.me/${withCountry}?text=${encodeURIComponent(message)}`;
  }

  function debounce(fn, wait = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // ---------- Menus de ação (dropdowns) ----------
  // Em vez de posicionar o menu com CSS (position: absolute relativo ao
  // botão), calculamos a posição em JS e aplicamos position: fixed. Isso faz
  // o menu escapar de qualquer overflow:hidden/auto de containers ancestrais
  // (ex.: .table-wrap) sem precisar mover o elemento no DOM — o que quebraria
  // a delegação de cliques que cada página já usa nos itens do menu.
  // Estado do menu aberto é único no módulo: só um menu fica aberto por vez
  // em toda a página (linhas de tabela e topbar incluídos).
  let _openMenu = null;
  let _openTrigger = null;

  function _clearMenuPosition(menu) {
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
    menu.style.visibility = '';
  }

  function closeOpenMenu() {
    if (_openMenu) {
      _openMenu.classList.remove('is-open');
      _clearMenuPosition(_openMenu);
    }
    _openMenu = null;
    _openTrigger = null;
  }

  function _positionMenu(trigger, menu) {
    const MARGIN = 8;
    menu.style.visibility = 'hidden';
    menu.classList.add('is-open');
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;

    let left = triggerRect.right - menuRect.width;
    if (left < MARGIN) left = MARGIN;
    if (left + menuRect.width > viewportW - MARGIN) left = Math.max(MARGIN, viewportW - MARGIN - menuRect.width);

    const spaceBelow = viewportH - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    let top;
    if (spaceBelow >= menuRect.height + MARGIN || spaceBelow >= spaceAbove) {
      top = triggerRect.bottom + 4;
    } else {
      top = triggerRect.top - menuRect.height - 4;
    }
    if (top < MARGIN) top = MARGIN;
    if (top + menuRect.height > viewportH - MARGIN) top = Math.max(MARGIN, viewportH - MARGIN - menuRect.height);

    menu.style.position = 'fixed';
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
  }

  function toggleMenu(trigger, menu) {
    if (_openMenu === menu) { closeOpenMenu(); return; }
    closeOpenMenu();
    _positionMenu(trigger, menu);
    _openMenu = menu;
    _openTrigger = trigger;
  }

  // Fecha/reposiciona em interações globais — registrado uma única vez.
  document.addEventListener('click', (e) => {
    if (!_openMenu) return;
    if (e.target.closest('.action-menu') || e.target.closest('[data-menu-toggle]')) return;
    closeOpenMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenMenu();
  });
  window.addEventListener('resize', () => {
    if (_openMenu && _openTrigger) _positionMenu(_openTrigger, _openMenu);
  });
  window.addEventListener('scroll', () => closeOpenMenu(), true);

  // Event-delegated dropdown menus for dynamically rendered rows.
  // Trigger: [data-menu-toggle="ID"]  Menu: [data-menu="ID"]
  function initActionMenus(root = document) {
    root.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-menu-toggle]');
      if (!trigger) return;
      e.stopPropagation();
      const id = trigger.getAttribute('data-menu-toggle');
      const menu = root.querySelector(`[data-menu="${id}"]`);
      if (menu) toggleMenu(trigger, menu);
    });
  }

  // Para pares botão/menu com IDs fixos (ex.: sino e menu do usuário no topbar).
  function wireMenuTrigger(trigger, menu) {
    if (!trigger || !menu) return;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu(trigger, menu);
    });
  }

  // ---------- Base URL do projeto (funciona em qualquer subdiretório, ex. GitHub Pages) ----------
  function appBaseUrl() {
    return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`;
  }

  // ---------- Rótulo de forma de pagamento (reaproveitado por listagens e PDF) ----------
  function paymentMethodLabel(forma, parcelas) {
    if (forma === 'pix') return 'Pix';
    if (forma === 'cartao') return parcelas > 1 ? `Cartão · ${parcelas}x` : 'Cartão · à vista';
    return forma || '—';
  }

  return {
    formatCurrency, formatDate, formatDateTime, initials, statusMeta, badgeHtml,
    escapeHtml, toast, confirmDialog, copyToClipboard, whatsappLink, debounce,
    initActionMenus, wireMenuTrigger, closeOpenMenu, appBaseUrl, paymentMethodLabel,
  };
})();
