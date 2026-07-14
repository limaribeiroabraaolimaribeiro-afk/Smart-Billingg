/* ==========================================================================
   Smart Billing — Shared cobrança row actions
   (usado em Dashboard, Cobranças e outras listagens)
   ========================================================================== */

const SB_ACTIONS = (() => {
  function publicUrl(cobranca) {
    return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}cobranca-publica.html?id=${cobranca.id}`;
  }

  function rowMenuHtml(cobranca) {
    const podeReceber = cobranca.status !== 'pago' && cobranca.status !== 'cancelado';
    const podeCancelar = cobranca.status !== 'cancelado' && cobranca.status !== 'pago';
    return `
      <button class="action-menu__item" data-act="view" data-id="${cobranca.id}">${SB_ICON.eye}<span>Visualizar cobrança</span></button>
      <button class="action-menu__item" data-act="whatsapp" data-id="${cobranca.id}">${SB_ICON.whatsapp}<span>Enviar pelo WhatsApp</span></button>
      <button class="action-menu__item" data-act="copy" data-id="${cobranca.id}">${SB_ICON.link}<span>Copiar link de pagamento</span></button>
      ${cobranca.status === 'pago' ? `<button class="action-menu__item" data-act="receipt" data-id="${cobranca.id}">${SB_ICON.download}<span>Baixar recibo</span></button>` : ''}
      <div class="action-menu__divider"></div>
      <button class="action-menu__item" data-act="edit" data-id="${cobranca.id}">${SB_ICON.edit}<span>Editar</span></button>
      ${podeReceber ? `<button class="action-menu__item" data-act="markpaid" data-id="${cobranca.id}">${SB_ICON.checkCircle}<span>Marcar como pago</span></button>` : ''}
      ${podeCancelar ? `<button class="action-menu__item is-danger" data-act="cancel" data-id="${cobranca.id}">${SB_ICON.ban}<span>Cancelar cobrança</span></button>` : ''}
    `;
  }

  async function handle(act, id, getCobranca, { onChange } = {}) {
    const cobranca = getCobranca(id);
    if (!cobranca) return;

    if (act === 'view') {
      window.open(`cobranca-publica.html?id=${cobranca.id}`, '_blank');
      return;
    }
    if (act === 'whatsapp') {
      const nome = cobranca.cliente?.nome || 'cliente';
      const msg = `Olá ${nome}! Segue o link para pagamento da cobrança "${cobranca.descricao}" no valor de ${SB_UI.formatCurrency(cobranca.valor)}: ${publicUrl(cobranca)}`;
      window.open(SB_UI.whatsappLink(cobranca.cliente?.whatsapp, msg), '_blank');
      return;
    }
    if (act === 'copy') {
      await SB_UI.copyToClipboard(publicUrl(cobranca));
      SB_UI.toast({ type: 'success', title: 'Link copiado', desc: 'O link de pagamento foi copiado para a área de transferência.' });
      return;
    }
    if (act === 'receipt') {
      SB_UI.toast({ type: 'success', title: 'Recibo gerado', desc: `Recibo da cobrança ${cobranca.codigo} pronto para download.` });
      return;
    }
    if (act === 'edit') {
      window.location.href = `cobranca-form.html?id=${cobranca.id}`;
      return;
    }
    if (act === 'markpaid') {
      const ok = await SB_UI.confirmDialog({
        title: 'Marcar como pago',
        desc: `Confirmar recebimento de ${SB_UI.formatCurrency(cobranca.valor)} referente a "${cobranca.descricao}"?`,
        confirmLabel: 'Confirmar recebimento',
        tone: 'warn',
      });
      if (!ok) return;
      await DB.cobrancas.markPaid(cobranca.id, { forma: cobranca.formaPagamento === 'ambos' ? 'pix' : cobranca.formaPagamento, parcelas: cobranca.parcelas });
      SB_UI.toast({ type: 'success', title: 'Pagamento confirmado', desc: 'A cobrança foi marcada como paga.' });
      onChange?.();
      return;
    }
    if (act === 'cancel') {
      const ok = await SB_UI.confirmDialog({
        title: 'Cancelar cobrança',
        desc: `Tem certeza que deseja cancelar "${cobranca.descricao}"? Essa ação não poderá ser desfeita.`,
        confirmLabel: 'Cancelar cobrança',
        cancelLabel: 'Voltar',
        tone: 'danger',
      });
      if (!ok) return;
      await DB.cobrancas.cancel(cobranca.id);
      SB_UI.toast({ type: 'info', title: 'Cobrança cancelada', desc: `${cobranca.codigo} foi cancelada.` });
      onChange?.();
    }
  }

  function wire(container, getCobranca, opts) {
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      handle(btn.dataset.act, btn.dataset.id, getCobranca, opts);
    });
  }

  return { rowMenuHtml, wire, publicUrl };
})();
