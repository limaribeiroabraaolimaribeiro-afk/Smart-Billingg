-- ============================================================================
-- Smart Billing — Diagnóstico de cobranças órfãs (client_id IS NULL)
-- ----------------------------------------------------------------------------
-- SOMENTE LEITURA. Este script não faz UPDATE, DELETE nem altera nenhuma
-- constraint — apenas consulta. Seguro para rodar quantas vezes quiser.
--
-- Contexto
-- --------
-- Antes de sql/fix_client_delete_cascade.sql, a foreign key
-- charges.client_id -> clients.id era "ON DELETE SET NULL". Ao excluir um
-- cliente, as cobranças dele não eram removidas: ficavam no banco com
-- client_id = NULL, e a interface passava a exibi-las como "Cliente
-- removido". O formulário de nova cobrança (cobranca-form.js) sempre exige
-- selecionar um cliente para salvar — não existe "cobrança avulsa" sem
-- cliente no app — então qualquer charges.client_id IS NULL hoje é,
-- necessariamente, resultado de uma exclusão de cliente feita ANTES da
-- correção, e não um uso legítimo do sistema.
--
-- Este script apenas mede o tamanho do problema (quantas cobranças órfãs
-- existem, e quais pagamentos/recibos pertencem a elas), para você decidir
-- se e quando quer limpar esses registros antigos com
-- sql/cleanup_orphan_charges.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Resumo geral: quantas cobranças órfãs existem, por status e valor
-- ----------------------------------------------------------------------------
select
  count(*)                                            as cobrancas_orfas,
  count(*) filter (where status = 'paid')             as orfas_pagas,
  count(*) filter (where status = 'pending')          as orfas_pendentes,
  count(*) filter (where status = 'overdue')          as orfas_atrasadas,
  count(*) filter (where status = 'cancelled')        as orfas_canceladas,
  coalesce(sum(amount), 0)                            as valor_total_envolvido,
  coalesce(sum(amount) filter (where status = 'paid'), 0) as valor_ja_recebido_envolvido,
  min(created_at)                                     as cobranca_orfa_mais_antiga,
  max(created_at)                                     as cobranca_orfa_mais_recente
from public.charges
where client_id is null;

-- ----------------------------------------------------------------------------
-- 2) Detalhe de cada cobrança órfã (empresa, valor, status, datas)
-- ----------------------------------------------------------------------------
select
  c.id,
  c.company_id,
  co.name as empresa,
  c.charge_number,
  c.description,
  c.amount,
  c.status,
  c.due_date,
  c.paid_at,
  c.created_at
from public.charges c
join public.companies co on co.id = c.company_id
where c.client_id is null
order by c.created_at desc;

-- ----------------------------------------------------------------------------
-- 3) Pagamentos vinculados a essas cobranças órfãs
--    (ficariam órfãos também se a cobrança fosse apagada sem cascade —
--     mas payments.charge_id já é ON DELETE CASCADE, então isso não
--     acontece: apagar a cobrança remove o pagamento junto)
-- ----------------------------------------------------------------------------
select
  p.id as payment_id,
  p.charge_id,
  c.charge_number,
  c.company_id,
  p.payment_method,
  p.gross_amount,
  p.net_amount,
  p.status as payment_status,
  p.paid_at
from public.payments p
join public.charges c on c.id = p.charge_id
where c.client_id is null
order by p.paid_at desc nulls last;

-- ----------------------------------------------------------------------------
-- 4) Recibos vinculados a essas cobranças órfãs
--    (receipts.charge_id e receipts.payment_id também já são
--     ON DELETE CASCADE)
-- ----------------------------------------------------------------------------
select
  r.id as receipt_id,
  r.charge_id,
  c.charge_number,
  r.payment_id,
  r.receipt_number,
  r.issued_at
from public.receipts r
join public.charges c on c.id = r.charge_id
where c.client_id is null
order by r.issued_at desc;

-- ----------------------------------------------------------------------------
-- 5) Resumo consolidado — "o que seria apagado" se você rodar
--    sql/cleanup_orphan_charges.sql
-- ----------------------------------------------------------------------------
select
  (select count(*) from public.charges where client_id is null)
    as total_cobrancas_orfas_a_remover,
  (select count(*)
     from public.payments p
     join public.charges c on c.id = p.charge_id
    where c.client_id is null)
    as total_pagamentos_removidos_em_cascata,
  (select count(*)
     from public.receipts r
     join public.charges c on c.id = r.charge_id
    where c.client_id is null)
    as total_recibos_removidos_em_cascata;
