/* ==========================================================================
   Smart Billing — Shared cobrança row actions
   (usado em Dashboard, Cobranças e outras listagens)
   ========================================================================== */

const SB_ACTIONS = (() => {
  const WA_STATUS_LABEL = { pending: 'Na fila', processing: 'Enviando', sent: 'Enviado', failed: 'Falhou', cancelled: 'Cancelado' };

  let _empresaNomeCache = null;
  async function getEmpresaNome() {
    if (_empresaNomeCache) return _empresaNomeCache;
    try {
      const empresa = await DB.empresa.get();
      _empresaNomeCache = empresa?.nome || 'Smart Billing';
    } catch (_) {
      _empresaNomeCache = 'Smart Billing';
    }
    return _empresaNomeCache;
  }

  // Chamado depois de marcar uma cobrança como paga. Só enfileira o recibo
  // pelo WhatsApp se a empresa tiver ligado a preferência em Configurações →
  // WhatsApp (whatsapp_settings.send_receipt_on_payment) e o cliente tiver
  // WhatsApp cadastrado. Nunca bloqueia nem falha visivelmente o fluxo de
  // "marcar como pago" — é sempre melhor esforço, registrado só no console.
  async function maybeAutoSendReceipt(cobranca, receiptId) {
    if (!receiptId || !cobranca.cliente?.whatsapp) return;
    try {
      const settings = await DB.whatsapp.getSettings();
      if (!settings?.sendReceiptOnPayment) return;
      const recibo = await DB.recibos.obterCompleto(receiptId);
      if (!recibo) return;
      const empresaNome = await getEmpresaNome();
      const message = SB_WA.receiptMessage(recibo, empresaNome);
      const result = await DB.whatsapp.enqueue({
        messageType: 'receipt',
        message,
        receiptId,
        clientId: cobranca.clienteId,
        idempotencyKey: `receipt:${receiptId}`,
      });
      if (result?.success) {
        SB_UI.toast({ type: 'info', title: 'Recibo adicionado à fila do WhatsApp' });
      }
    } catch (err) {
      console.error('[Smart Billing] Falha ao enfileirar recibo automático no WhatsApp:', err);
    }
  }

  function publicUrl(cobranca) {
    const base = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`;
    return `${base}cobranca-publica.html?token=${cobranca.publicToken || cobranca.id}`;
  }

  function rowMenuHtml(cobranca) {
    const podeReceber = cobranca.status !== 'pago' && cobranca.status !== 'cancelado';
    const podeCancelar = cobranca.status !== 'cancelado' && cobranca.status !== 'pago';
    const temCheckout = Boolean(cobranca.checkoutUrl);
    const podeGerarCheckout = podeReceber && !temCheckout;
    const podeLembrete = cobranca.status === 'pendente' || cobranca.status === 'atrasado';
    return `
      <button class="action-menu__item" data-act="view" data-id="${cobranca.id}">${SB_ICON.eye}<span>Visualizar cobrança</span></button>
      ${temCheckout ? `<button class="action-menu__item" data-act="opencheckout" data-id="${cobranca.id}">${SB_ICON.externalLink}<span>Abrir checkout</span></button>` : ''}
      <button class="action-menu__item" data-act="whatsapp" data-id="${cobranca.id}">${SB_ICON.whatsapp}<span>Abrir no WhatsApp Web</span></button>
      <button class="action-menu__item" data-act="whatsapp-send" data-id="${cobranca.id}">${SB_ICON.whatsapp}<span>Enviar cobrança (agente WhatsApp)</span></button>
      ${podeLembrete ? `<button class="action-menu__item" data-act="whatsapp-reminder" data-id="${cobranca.id}">${SB_ICON.clock}<span>Enviar lembrete (agente WhatsApp)</span></button>` : ''}
      <button class="action-menu__item" data-act="whatsapp-copy" data-id="${cobranca.id}">${SB_ICON.copy}<span>Copiar mensagem</span></button>
      <button class="action-menu__item" data-act="whatsapp-history" data-id="${cobranca.id}">${SB_ICON.clock}<span>Ver histórico de envio</span></button>
      <button class="action-menu__item" data-act="copy" data-id="${cobranca.id}">${SB_ICON.link}<span>Copiar link de pagamento</span></button>
      ${podeGerarCheckout ? `<button class="action-menu__item" data-act="checkout" data-id="${cobranca.id}">${SB_ICON.refreshCw}<span>Gerar checkout novamente</span></button>` : ''}
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
      window.open(publicUrl(cobranca), '_blank');
      return;
    }
    if (act === 'opencheckout') {
      if (cobranca.checkoutUrl) window.open(cobranca.checkoutUrl, '_blank');
      return;
    }
    if (act === 'whatsapp') {
      const nome = cobranca.cliente?.nome || 'cliente';
      const link = cobranca.checkoutUrl || publicUrl(cobranca);
      const msg = `Olá ${nome}! Segue o link para pagamento da cobrança "${cobranca.descricao}" no valor de ${SB_UI.formatCurrency(cobranca.valor)}: ${link}`;
      window.open(SB_UI.whatsappLink(cobranca.cliente?.whatsapp, msg), '_blank');
      return;
    }
    if (act === 'copy') {
      await SB_UI.copyToClipboard(publicUrl(cobranca));
      SB_UI.toast({ type: 'success', title: 'Link copiado', desc: 'O link de pagamento foi copiado para a área de transferência.' });
      return;
    }
    if (act === 'whatsapp-send' || act === 'whatsapp-reminder') {
      SB_UI.closeOpenMenu();
      if (!cobranca.cliente?.whatsapp) {
        SB_UI.toast({ type: 'error', title: 'Cliente sem WhatsApp cadastrado', desc: 'Cadastre um WhatsApp para este cliente antes de enviar.' });
        return;
      }
      const empresaNome = await getEmpresaNome();
      const isReminder = act === 'whatsapp-reminder';
      const kind = isReminder ? SB_WA.reminderKindFor(cobranca) : null;
      const message = isReminder ? SB_WA.reminderMessage(kind, cobranca, empresaNome) : SB_WA.chargeMessage(cobranca, empresaNome);
      const ok = await SB_UI.confirmDialog({
        title: isReminder ? 'Enviar lembrete pelo WhatsApp' : 'Enviar cobrança pelo WhatsApp',
        desc: `Enviar para ${cobranca.cliente.whatsapp}? A mensagem entra na fila do agente de WhatsApp conectado.`,
        confirmLabel: 'Adicionar à fila',
        cancelLabel: 'Cancelar',
        tone: 'warn',
      });
      if (!ok) return;

      SB_UI.toast({ type: 'info', title: 'Adicionando à fila...' });
      try {
        const result = await DB.whatsapp.enqueue({
          messageType: isReminder ? (kind === 'overdue' ? 'overdue_reminder' : 'due_soon_reminder') : 'charge',
          message,
          chargeId: cobranca.id,
          clientId: cobranca.clienteId,
          idempotencyKey: `${isReminder ? 'reminder' : 'charge'}:${cobranca.id}:${Date.now()}`,
        });
        if (result?.success) {
          SB_UI.toast({ type: 'success', title: 'Mensagem adicionada à fila', desc: 'Será enviada quando o WhatsApp estiver conectado.' });
        } else {
          console.error('[Smart Billing] Falha ao enfileirar mensagem de WhatsApp:', result?.message);
          SB_UI.toast({ type: 'error', title: 'Não foi possível enfileirar a mensagem', desc: result?.message || 'Tente novamente em instantes.' });
        }
      } catch (err) {
        console.error('[Smart Billing] Erro inesperado ao enfileirar WhatsApp:', err);
        SB_UI.toast({ type: 'error', title: 'Não foi possível enfileirar a mensagem', desc: 'Tente novamente em instantes.' });
      }
      return;
    }
    if (act === 'whatsapp-copy') {
      SB_UI.closeOpenMenu();
      const empresaNome = await getEmpresaNome();
      await SB_UI.copyToClipboard(SB_WA.chargeMessage(cobranca, empresaNome));
      SB_UI.toast({ type: 'success', title: 'Mensagem copiada' });
      return;
    }
    if (act === 'whatsapp-history') {
      SB_UI.closeOpenMenu();
      try {
        const history = await DB.whatsapp.history({ chargeId: cobranca.id, limit: 5 });
        if (!history.length) {
          SB_UI.toast({ type: 'info', title: 'Nenhum envio registrado ainda' });
          return;
        }
        const last = history[0];
        const sent = history.filter((h) => h.status === 'sent').length;
        const failed = history.filter((h) => h.status === 'failed').length;
        const pending = history.filter((h) => h.status === 'pending' || h.status === 'processing').length;
        SB_UI.toast({
          type: last.status === 'failed' ? 'error' : (last.status === 'sent' ? 'success' : 'info'),
          title: `Último envio: ${WA_STATUS_LABEL[last.status] || last.status}`,
          desc: `${sent} enviada(s) · ${failed} falhada(s) · ${pending} na fila · ${SB_UI.formatDateTime(last.createdAt)}`,
        });
      } catch (err) {
        console.error('[Smart Billing] Falha ao carregar histórico de WhatsApp:', err);
        SB_UI.toast({ type: 'error', title: 'Não foi possível carregar o histórico' });
      }
      return;
    }
    if (act === 'checkout') {
      SB_UI.toast({ type: 'info', title: 'Gerando checkout...', desc: cobranca.codigo });
      const result = await DB.cobrancas.generateCheckout(cobranca.id);
      if (result?.success) {
        SB_UI.toast({ type: 'success', title: 'Link de pagamento criado com sucesso', desc: cobranca.codigo });
      } else {
        SB_UI.toast({ type: 'error', title: 'Não foi possível gerar o checkout', desc: result?.message || 'Tente novamente em instantes.' });
      }
      onChange?.();
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
      const result = await DB.cobrancas.markPaid(cobranca.id, { forma: cobranca.formaPagamento === 'ambos' ? 'pix' : cobranca.formaPagamento, parcelas: cobranca.parcelas });
      SB_UI.toast({ type: 'success', title: 'Pagamento confirmado', desc: 'A cobrança foi marcada como paga.' });
      maybeAutoSendReceipt(cobranca, result?.recibo?.id);
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
