'use strict';

// ============================================================================
// Modelos de mensagem de lembrete — WORKER (Node.js).
// ----------------------------------------------------------------------------
// Porta o MESMO texto/formato de assets/js/whatsapp-templates.js
// (reminderMessage/REMINDER_LABEL) para rodar fora do navegador — o worker
// não tem acesso a SB_UI nem a window.location. Nenhuma frase nova foi
// inventada aqui: é a cópia exata das mensagens já usadas pelo painel para
// o envio manual de lembretes, só reimplementada sem dependências de DOM.
//
// "kind" usa os mesmos valores de whatsapp-templates.js:
//   'due_soon_3' | 'due_soon_1' | 'due_today' | 'overdue'
// ============================================================================

const { formatDateBR, formatCurrencyBRL } = require('./timezone');
const config = require('./config');

function publicChargeUrl(charge) {
  const base = config.publicAppUrl ? `${config.publicAppUrl}/` : '';
  return `${base}cobranca-publica.html?token=${charge.public_token}`;
}

const REMINDER_LABEL = {
  due_soon_3: (charge) => `Sua cobrança vence em 3 dias, no dia ${formatDateBR(charge.due_date)}.`,
  due_soon_1: (charge) => `Sua cobrança vence amanhã (${formatDateBR(charge.due_date)}).`,
  due_today: () => 'Sua cobrança vence hoje.',
  overdue: (charge) => `Sua cobrança venceu em ${formatDateBR(charge.due_date)} e ainda não identificamos o pagamento.`,
};

// charge: { id, charge_number, description, amount, due_date, public_token }
// clientName: string
function reminderMessage(kind, charge, clientName, companyName) {
  const labelFn = REMINDER_LABEL[kind] || REMINDER_LABEL.due_today;
  return [
    `Olá, ${clientName || 'cliente'}! ⏰`,
    '',
    labelFn(charge),
    '',
    `💰 Valor: ${formatCurrencyBRL(charge.amount)}`,
    `📝 Descrição: ${charge.description}`,
    `🔖 Código: ${charge.charge_number}`,
    '',
    'Para visualizar e pagar com Pix ou cartão:',
    publicChargeUrl(charge),
    '',
    `${companyName} · mensagem automática do Smart Billing.`,
  ].join('\n');
}

// Resumo diário consolidado — no máximo 1 mensagem automática por cliente
// por dia (ver src/billing.js), mesmo que ele tenha várias cobranças
// elegíveis. "charges" já vem ordenado por prioridade (mais urgente
// primeiro) e com "label" pronto (calculado no servidor — ver
// list_reminder_candidates), então este módulo só formata o texto.
// charges: [{ id, charge_number, description, amount, due_date, public_token, kind, label }]
function dailyDigestMessage(charges, clientName, companyName) {
  const n = charges.length;
  const linhas = charges.map((c) => `• ${c.charge_number} — ${formatCurrencyBRL(c.amount)} — ${c.label}`);
  const links = charges.map((c) => publicChargeUrl(c));

  return [
    `Olá, ${clientName || 'cliente'}! ⏰`,
    '',
    n > 1 ? `Você possui ${n} cobranças pendentes:` : 'Você possui 1 cobrança pendente:',
    '',
    ...linhas,
    '',
    n > 1 ? 'Acesse os links abaixo para visualizar e pagar:' : 'Acesse o link abaixo para visualizar e pagar:',
    ...links,
    '',
    `${companyName} · mensagem automática do Smart Billing.`,
  ].join('\n');
}

module.exports = { reminderMessage, dailyDigestMessage, publicChargeUrl };
