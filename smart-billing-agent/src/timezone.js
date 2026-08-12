'use strict';

// ============================================================================
// Helpers de data/hora em America/Sao_Paulo.
// ----------------------------------------------------------------------------
// A VPS (Ubuntu) normalmente roda em UTC por padrão. O Smart Billing sempre
// trabalha com datas de vencimento/cobrança no horário do Brasil — nenhuma
// comparação de data neste projeto deve depender do timezone padrão do
// processo Node. Este módulo centraliza essas conversões para o worker.
// ============================================================================

const TIMEZONE = 'America/Sao_Paulo';

// "YYYY-MM-DD" de agora, já em America/Sao_Paulo (para comparar com colunas
// DATE puras como charges.due_date, sem hora envolvida).
function todayISODate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

// Formata uma data "YYYY-MM-DD" (ou ISO completo) como DD/MM/AAAA, igual ao
// SB_UI.formatDate() do frontend — mas com timeZone explícito, já que o
// processo do worker pode estar rodando em UTC.
function formatDateBR(dateLike) {
  if (!dateLike) return '—';
  const iso = typeof dateLike === 'string' && dateLike.length === 10 ? `${dateLike}T12:00:00Z` : dateLike;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: TIMEZONE });
}

function formatCurrencyBRL(value) {
  return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

module.exports = { TIMEZONE, todayISODate, formatDateBR, formatCurrencyBRL };
