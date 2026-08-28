-- ============================================================================
-- Smart Billing — Seed opcional dos 3 planos iniciais (Mensal / Anual / 2 anos)
-- ----------------------------------------------------------------------------
-- Rode DEPOIS de sql/billing_plans.sql. Idempotente: para cada empresa que
-- ainda não tem um plano com aquele nome exato, insere um; se já existir
-- (mesmo company_id + name, respeitando a unique(company_id, name) de
-- billing_plans), não faz nada — seguro rodar mais de uma vez.
--
-- Por padrão, cria os 3 planos para TODAS as empresas já cadastradas (troque
-- o "where true" abaixo por "where id = '<company_id da sua empresa>'::uuid"
-- se quiser aplicar só a uma empresa específica).
-- ============================================================================

insert into public.billing_plans (
  company_id, name, short_description, amount, reference_amount,
  discount_percent, duration_months, billing_type, badge, featured,
  max_installments, sort_order
)
select
  co.id, 'Mensal', 'Flexível', 190.00, null, 0, 1, 'recurring_monthly', null, false, 12, 1
from public.companies co
where true
  and not exists (select 1 from public.billing_plans bp where bp.company_id = co.id and bp.name = 'Mensal');

insert into public.billing_plans (
  company_id, name, short_description, amount, reference_amount,
  discount_percent, duration_months, billing_type, badge, featured,
  max_installments, sort_order
)
select
  co.id, 'Anual', null, 1938.00, 2280.00, 15, 12, 'one_time', 'MAIS ESCOLHIDO', true, 12, 2
from public.companies co
where true
  and not exists (select 1 from public.billing_plans bp where bp.company_id = co.id and bp.name = 'Anual');

insert into public.billing_plans (
  company_id, name, short_description, amount, reference_amount,
  discount_percent, duration_months, billing_type, badge, featured,
  max_installments, sort_order
)
select
  co.id, '2 anos', null, 3648.00, 4560.00, 20, 24, 'one_time', 'MELHOR ECONOMIA', false, 12, 3
from public.companies co
where true
  and not exists (select 1 from public.billing_plans bp where bp.company_id = co.id and bp.name = '2 anos');

-- Verificação (apenas leitura)
select co.name as empresa, bp.name as plano, bp.amount, bp.billing_type, bp.badge
from public.billing_plans bp
join public.companies co on co.id = bp.company_id
where bp.name in ('Mensal', 'Anual', '2 anos')
order by co.name, bp.sort_order;
