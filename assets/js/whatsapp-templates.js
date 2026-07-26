/* ==========================================================================
   Smart Billing — Modelos de mensagem do agente de WhatsApp
   --------------------------------------------------------------------------
   Usado por cobrancas.js/actions.js, recibos.js e cobranca-form.js para
   montar o texto exatamente igual em qualquer lugar que enfileira uma
   mensagem (DB.whatsapp.enqueue). Depende de SB_UI (formatCurrency/
   formatDate/formatDateTime/appBaseUrl) — carregar depois de ui.js.

   Nunca inclui UUIDs, company_id, client_id, payment_id ou o checkout_url
   direto da InfinitePay: os links sempre apontam para as páginas públicas
   do próprio Smart Billing, que continuam responsáveis por exibir os dados
   e abrir o checkout.
   ========================================================================== */

const SB_WA = (() => {
  function publicChargeUrl(cobranca) {
    return `${SB_UI.appBaseUrl()}cobranca-publica.html?token=${cobranca.publicToken || cobranca.id}`;
  }

  function publicReceiptUrl(recibo) {
    return `${SB_UI.appBaseUrl()}recibo-publico.html?token=${recibo.publicToken || recibo.id}`;
  }

  function chargeMessage(cobranca, empresaNome) {
    return [
      `Olá, ${cobranca.cliente?.nome || 'cliente'}! 👋`,
      '',
      `Você recebeu uma nova cobrança de *${empresaNome}*.`,
      '',
      `💰 Valor: ${SB_UI.formatCurrency(cobranca.valor)}`,
      `📅 Vencimento: ${SB_UI.formatDate(cobranca.vencimento)}`,
      `📝 Descrição: ${cobranca.descricao}`,
      `🔖 Código: ${cobranca.codigo}`,
      '',
      'Para visualizar e pagar com Pix ou cartão:',
      publicChargeUrl(cobranca),
      '',
      'Esta é uma mensagem automática enviada pelo Smart Billing.',
    ].join('\n');
  }

  function receiptMessage(recibo, empresaNome) {
    return [
      `Olá, ${recibo.cliente?.nome || 'cliente'}! ✅`,
      '',
      'Seu pagamento foi confirmado.',
      '',
      `💰 Valor pago: ${SB_UI.formatCurrency(recibo.pagamento?.valor || 0)}`,
      `🧾 Recibo: ${recibo.numero}`,
      `🔖 Cobrança: ${recibo.cobranca?.codigo || '—'}`,
      `📅 Pagamento: ${SB_UI.formatDateTime(recibo.pagamento?.dataHora || recibo.geradoEm)}`,
      '',
      'Visualize seu recibo:',
      publicReceiptUrl(recibo),
      '',
      `Obrigado! — ${empresaNome}`,
    ].join('\n');
  }

  // kind: 'due_soon_3' | 'due_soon_1' | 'due_today' | 'overdue'
  const REMINDER_LABEL = {
    due_soon_3: (c) => `Sua cobrança vence em 3 dias, no dia ${SB_UI.formatDate(c.vencimento)}.`,
    due_soon_1: (c) => `Sua cobrança vence amanhã (${SB_UI.formatDate(c.vencimento)}).`,
    due_today: () => 'Sua cobrança vence hoje.',
    overdue: (c) => `Sua cobrança venceu em ${SB_UI.formatDate(c.vencimento)} e ainda não identificamos o pagamento.`,
  };

  function reminderMessage(kind, cobranca, empresaNome) {
    const labelFn = REMINDER_LABEL[kind] || REMINDER_LABEL.due_today;
    return [
      `Olá, ${cobranca.cliente?.nome || 'cliente'}! ⏰`,
      '',
      labelFn(cobranca),
      '',
      `💰 Valor: ${SB_UI.formatCurrency(cobranca.valor)}`,
      `📝 Descrição: ${cobranca.descricao}`,
      `🔖 Código: ${cobranca.codigo}`,
      '',
      'Para visualizar e pagar com Pix ou cartão:',
      publicChargeUrl(cobranca),
      '',
      `${empresaNome} · mensagem automática do Smart Billing.`,
    ].join('\n');
  }

  // Deriva automaticamente qual lembrete faz sentido para o vencimento atual
  // da cobrança (usado pela ação manual "Enviar lembrete").
  function reminderKindFor(cobranca) {
    const dias = Math.ceil((new Date(cobranca.vencimento) - new Date(new Date().toDateString())) / 86400000);
    if (cobranca.status === 'atrasado' || dias < 0) return 'overdue';
    if (dias === 0) return 'due_today';
    if (dias === 1) return 'due_soon_1';
    return 'due_soon_3';
  }

  return { chargeMessage, receiptMessage, reminderMessage, reminderKindFor, publicChargeUrl, publicReceiptUrl };
})();
