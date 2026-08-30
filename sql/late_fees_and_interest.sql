-- ============================================================================
-- Smart Billing — Multa e juros de mora por atraso
-- ----------------------------------------------------------------------------
-- Migração idempotente: pode ser executada quantas vezes for necessário no
-- SQL Editor do Supabase sem apagar dados existentes. Rode depois de
-- sql/supabase_schema.sql e sql/infinitepay_integration.sql já terem sido
-- aplicados.
--
-- REGRA DE NEGÓCIO (nunca calculada no navegador):
--   multa  = valor_original * (late_fee_percent / 100)                  — uma vez só
--   juros  = valor_original * (late_interest_monthly_percent / 100) * (dias_atraso / 30)
--   total  = valor_original + multa + juros
-- Juros simples (não compostos), proporcional por dia, começando no 1º dia
-- após due_date. Nunca incide sobre parcelamento do cartão da InfinitePay —
-- só sobre cobranças do Smart Billing que passaram da própria due_date.
--
-- charges.amount continua sendo o valor ORIGINAL, imutável — nada que já lê
-- esse campo (listagens, recibos, relatórios) precisa mudar. O valor "vivo"
-- com encargos vive em charges.updated_amount, calculado por
-- calculate_late_charges() e só GRAVADO (via lock_late_charge_amount) no
-- exato momento em que um checkout precisa ser gerado — nunca antes disso,
-- e nunca a partir de um valor enviado pelo cliente.
--
-- Conteúdo:
--   1. Configuração por empresa (companies.late_fee_*).
--   2. Colunas de encargos em charges (updated_amount, late_fee_amount,
--      late_interest_amount, late_fee_calculated_at).
--   3. calculate_late_charges() — cálculo puro, sem gravar nada.
--   4. lock_late_charge_amount() — trava o cálculo do dia em charges (só
--      service_role, chamada pelas Edge Functions antes de gerar checkout).
--   5. get_public_charge_by_token() — estendida com os campos de encargos.
--   6. register_infinitepay_payment() / register_manual_payment() —
--      passam a considerar updated_amount (quando existir) como o valor
--      esperado/recebido, preservando o histórico de encargos já gravado.
-- ============================================================================


-- ============================================================================
-- 1. Configuração de multa/juros por empresa
-- ----------------------------------------------------------------------------
-- late_fee_percent tem CHECK <= 2.00 de propósito — limite legal de multa de
-- mora (CDC art. 52 §1º) para contratos de consumo. Não é só uma sugestão de
-- UI: o banco recusa qualquer valor acima disso, mesmo via SQL direto.
-- ============================================================================
alter table public.companies
  add column if not exists late_fee_enabled boolean not null default true,
  add column if not exists late_fee_percent numeric(5, 2) not null default 2.00,
  add column if not exists late_interest_monthly_percent numeric(5, 2) not null default 1.00;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_late_fee_percent_max_2'
  ) then
    alter table public.companies
      add constraint companies_late_fee_percent_max_2 check (late_fee_percent >= 0 and late_fee_percent <= 2.00);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'companies_late_interest_non_negative'
  ) then
    alter table public.companies
      add constraint companies_late_interest_non_negative check (late_interest_monthly_percent >= 0);
  end if;
end $$;

comment on column public.companies.late_fee_enabled is 'Se falso, cobranças vencidas nunca recebem multa/juros (updated_amount = amount sempre).';
comment on column public.companies.late_fee_percent is 'Multa de mora, uma única vez após o vencimento. Máximo 2% (limite legal, CDC art. 52 §1º).';
comment on column public.companies.late_interest_monthly_percent is 'Juros de mora simples, ao mês, aplicados proporcionalmente aos dias de atraso.';


-- ============================================================================
-- 2. Encargos por cobrança
-- ----------------------------------------------------------------------------
-- amount permanece o valor original/contratado, sem nenhuma mudança de
-- comportamento para quem já lê esse campo. updated_amount só é preenchido
-- quando lock_late_charge_amount() é chamada (ao gerar/regenerar checkout de
-- uma cobrança vencida) — antes disso é null, e todo o resto do sistema deve
-- tratar null como "sem encargos, valor devido = amount".
-- ============================================================================
alter table public.charges
  add column if not exists updated_amount numeric(12, 2),
  add column if not exists late_fee_amount numeric(12, 2) not null default 0,
  add column if not exists late_interest_amount numeric(12, 2) not null default 0,
  add column if not exists late_fee_calculated_at timestamptz;

comment on column public.charges.updated_amount is 'Valor travado (amount + multa + juros) no momento em que o checkout atual foi gerado. Null = nunca teve encargos calculados.';
comment on column public.charges.late_fee_amount is 'Multa aplicada (histórico preservado mesmo após o pagamento).';
comment on column public.charges.late_interest_amount is 'Juros de mora aplicados (histórico preservado mesmo após o pagamento).';
comment on column public.charges.late_fee_calculated_at is 'Quando updated_amount/late_fee_amount/late_interest_amount foram calculados pela última vez.';


-- ============================================================================
-- 3. calculate_late_charges — cálculo puro (não grava nada)
-- ----------------------------------------------------------------------------
-- Para cobranças pending/overdue: calcula em cima de current_date (o valor
-- muda dia a dia até alguém travá-lo com lock_late_charge_amount).
-- Para cobranças paid/cancelled: devolve o que já está gravado na linha (o
-- que foi de fato cobrado/pago), nunca recalcula pra não parecer que os
-- juros continuam correndo depois do pagamento confirmado.
-- SECURITY DEFINER mas SEM grant a anon/authenticated — só é chamada de
-- dentro de outras funções SECURITY DEFINER (get_public_charge_by_token) e
-- pelas Edge Functions via service_role.
-- ============================================================================
create or replace function public.calculate_late_charges(p_charge_id uuid)
returns table (
  original_amount        numeric,
  due_date                date,
  days_overdue            integer,
  late_fee_amount         numeric,
  late_interest_amount    numeric,
  updated_amount          numeric,
  calculation_date        date
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_charge  public.charges%rowtype;
  v_company public.companies%rowtype;
  v_days    integer;
  v_fee     numeric(12, 2) := 0;
  v_interest numeric(12, 2) := 0;
begin
  select * into v_charge from public.charges where id = p_charge_id;
  if not found then
    raise exception 'Cobrança não encontrada';
  end if;

  -- Pago/cancelado: devolve o snapshot já travado, nunca recalcula.
  if v_charge.status in ('paid', 'cancelled') then
    return query select
      v_charge.amount,
      v_charge.due_date,
      greatest(0, coalesce(v_charge.late_fee_calculated_at::date, v_charge.due_date) - v_charge.due_date)::integer,
      coalesce(v_charge.late_fee_amount, 0),
      coalesce(v_charge.late_interest_amount, 0),
      coalesce(v_charge.updated_amount, v_charge.amount),
      coalesce(v_charge.late_fee_calculated_at::date, current_date);
    return;
  end if;

  select * into v_company from public.companies where id = v_charge.company_id;

  v_days := greatest(0, (current_date - v_charge.due_date))::integer;

  if v_company.late_fee_enabled and v_days > 0 then
    -- least(...,2.00) reforça o teto legal mesmo se a coluna tiver sido
    -- alterada por algum caminho que não passe pelo CHECK (defesa em camadas).
    v_fee := round(v_charge.amount * (least(v_company.late_fee_percent, 2.00) / 100), 2);
    v_interest := round(v_charge.amount * (v_company.late_interest_monthly_percent / 100) * (v_days::numeric / 30), 2);
  end if;

  return query select
    v_charge.amount,
    v_charge.due_date,
    v_days,
    v_fee,
    v_interest,
    v_charge.amount + v_fee + v_interest,
    current_date;
end;
$$;
comment on function public.calculate_late_charges(uuid) is
  'Calcula multa/juros de mora de uma cobrança (puro, não grava nada). Congela o valor após pago/cancelado.';


-- ============================================================================
-- 4. lock_late_charge_amount — trava o cálculo do dia na própria cobrança
-- ----------------------------------------------------------------------------
-- Chamada pelas Edge Functions (service_role) exatamente antes de gerar um
-- checkout novo pra uma cobrança vencida — nunca a partir de um valor vindo
-- do navegador. Idempotente: chamar de novo no mesmo dia grava os mesmos
-- números (a data de vencimento e a config da empresa não mudaram).
-- ============================================================================
create or replace function public.lock_late_charge_amount(p_charge_id uuid)
returns public.charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_calc   record;
  v_charge public.charges;
begin
  select * into v_calc from public.calculate_late_charges(p_charge_id);

  update public.charges
  set updated_amount = v_calc.updated_amount,
      late_fee_amount = v_calc.late_fee_amount,
      late_interest_amount = v_calc.late_interest_amount,
      late_fee_calculated_at = now()
  where id = p_charge_id
  returning * into v_charge;

  return v_charge;
end;
$$;
comment on function public.lock_late_charge_amount(uuid) is
  'Trava multa/juros calculados agora na própria cobrança — chamada só pelas Edge Functions antes de gerar checkout.';

revoke all on function public.lock_late_charge_amount(uuid) from public, anon, authenticated;
grant execute on function public.lock_late_charge_amount(uuid) to service_role;


-- ============================================================================
-- 5. get_public_charge_by_token — estendida com os campos de encargos
-- ----------------------------------------------------------------------------
-- Precisa DROP + CREATE (não CREATE OR REPLACE) porque a lista de colunas de
-- retorno mudou — Postgres não permite alterar o retorno de uma função com
-- REPLACE. Comportamento pra quem já lê os campos antigos não muda em nada;
-- só ganham campos novos.
-- ============================================================================
drop function if exists public.get_public_charge_by_token(uuid);

create function public.get_public_charge_by_token(p_token uuid)
returns table (
  id                      uuid,
  charge_number           text,
  description             text,
  amount                  numeric,
  due_date                date,
  status                  public.charge_status,
  payment_methods         jsonb,
  max_installments        integer,
  checkout_url            text,
  paid_at                 timestamptz,
  cancelled_at            timestamptz,
  client_name             text,
  company_name            text,
  days_overdue            integer,
  late_fee_amount         numeric,
  late_interest_amount    numeric,
  updated_amount          numeric,
  late_fee_calculated_at  date,
  late_fee_enabled        boolean,
  late_fee_percent        numeric,
  late_interest_monthly_percent numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_charge_id uuid;
  v_calc      record;
begin
  select c.id into v_charge_id from public.charges c where c.public_token = p_token;
  if v_charge_id is null then
    return;
  end if;

  select * into v_calc from public.calculate_late_charges(v_charge_id);

  return query
    select
      c.id,
      c.charge_number,
      c.description,
      c.amount,
      c.due_date,
      c.status,
      c.payment_methods,
      c.max_installments,
      c.checkout_url,
      c.paid_at,
      c.cancelled_at,
      cl.name as client_name,
      co.name as company_name,
      v_calc.days_overdue,
      v_calc.late_fee_amount,
      v_calc.late_interest_amount,
      v_calc.updated_amount,
      v_calc.calculation_date,
      co.late_fee_enabled,
      co.late_fee_percent,
      co.late_interest_monthly_percent
    from public.charges c
    left join public.clients cl on cl.id = c.client_id
    join public.companies co on co.id = c.company_id
    where c.id = v_charge_id;
end;
$$;
comment on function public.get_public_charge_by_token(uuid) is
  'Retorna dados públicos e seguros de UMA cobrança via public_token, sem exigir login, incluindo multa/juros calculados ao vivo.';

grant execute on function public.get_public_charge_by_token(uuid) to anon, authenticated;


-- ============================================================================
-- 6. register_infinitepay_payment / register_manual_payment — passam a
--    considerar updated_amount (quando existir) como o valor esperado/pago.
-- ----------------------------------------------------------------------------
-- Para cobranças que nunca tiveram encargos calculados, updated_amount é
-- null e coalesce(...) devolve amount — comportamento idêntico ao atual,
-- zero regressão pra cobranças em dia.
-- ============================================================================
create or replace function public.register_infinitepay_payment(
  p_charge_id         uuid,
  p_transaction_nsu   text,
  p_payment_method    public.payment_method_type,
  p_installments      integer,
  p_amount_cents      bigint,
  p_paid_amount_cents bigint,
  p_receipt_url       text,
  p_raw_payload       jsonb
)
returns table (
  payment_id        uuid,
  receipt_id        uuid,
  already_processed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge          public.charges%rowtype;
  v_existing_pay_id uuid;
  v_existing_rec_id uuid;
  v_payment_id      uuid;
  v_receipt_id      uuid;
  v_receipt_no      text;
  v_gross_amount    numeric(12, 2);
  v_confirmed_amt   numeric(12, 2);
  v_expected_amt    numeric(12, 2);
begin
  if p_transaction_nsu is null or length(trim(p_transaction_nsu)) = 0 then
    raise exception 'transaction_nsu é obrigatório';
  end if;

  select * into v_charge from public.charges where id = p_charge_id for update;

  if not found then
    raise exception 'Cobrança não encontrada';
  end if;

  if v_charge.status = 'cancelled' then
    raise exception 'Cobrança cancelada não pode receber pagamento';
  end if;

  -- Idempotência: se esta transação já foi processada antes, devolve os IDs
  -- existentes sem inserir nada novo (o mesmo webhook pode chegar 2x, e a
  -- página de confirmação pode consultar várias vezes).
  select p.id, r.id
    into v_existing_pay_id, v_existing_rec_id
  from public.payments p
  left join public.receipts r on r.payment_id = p.id
  where p.provider = 'infinitepay'
    and p.provider_transaction_id = p_transaction_nsu
  limit 1;

  if found then
    return query select v_existing_pay_id, v_existing_rec_id, true;
    return;
  end if;

  -- Cobrança já paga por outro pagamento (não esta transação) — não soma de novo.
  if v_charge.status = 'paid' then
    raise exception 'Cobrança já está paga';
  end if;

  v_confirmed_amt := round((p_amount_cents::numeric) / 100.0, 2);
  v_expected_amt := coalesce(v_charge.updated_amount, v_charge.amount);

  if v_confirmed_amt <> v_expected_amt then
    raise exception 'Valor divergente: confirmado % , esperado %', v_confirmed_amt, v_expected_amt;
  end if;

  v_gross_amount := v_expected_amt;

  insert into public.payments (
    company_id, charge_id, provider, provider_transaction_id, payment_method,
    installments, gross_amount, fee_amount, net_amount, status, paid_at,
    receipt_url, raw_payload
  ) values (
    v_charge.company_id, v_charge.id, 'infinitepay', p_transaction_nsu, p_payment_method,
    coalesce(p_installments, 1), v_gross_amount, 0, v_gross_amount, 'approved', now(),
    p_receipt_url, p_raw_payload
  ) returning id into v_payment_id;

  update public.charges
  set status = 'paid', paid_at = now()
  where id = v_charge.id;

  -- Cria o recibo somente se ainda não existir um para esta cobrança.
  select r.id into v_existing_rec_id
  from public.receipts r
  where r.charge_id = v_charge.id
  limit 1;

  if found then
    v_receipt_id := v_existing_rec_id;
  else
    v_receipt_no := 'REC-' || lpad(nextval('public.charge_number_seq')::text, 6, '0');
    insert into public.receipts (company_id, charge_id, payment_id, receipt_number, issued_at)
    values (v_charge.company_id, v_charge.id, v_payment_id, v_receipt_no, now())
    returning id into v_receipt_id;
  end if;

  return query select v_payment_id, v_receipt_id, false;
end;
$$;
comment on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) is 'Registra pagamento confirmado da InfinitePay (webhook ou check-infinitepay-payment) de forma atômica e idempotente por transaction_nsu. Valor esperado considera updated_amount quando a cobrança tiver encargos travados.';

revoke all on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) from public, anon, authenticated;

grant execute on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) to service_role;


create or replace function public.register_manual_payment(
  p_charge_id uuid,
  p_payment_method public.payment_method_type,
  p_installments integer default 1
)
returns table (
  charge_id     uuid,
  payment_id    uuid,
  receipt_id    uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge      public.charges%rowtype;
  v_payment_id  uuid;
  v_receipt_id  uuid;
  v_receipt_no  text;
  v_amount      numeric(12, 2);
begin
  select * into v_charge from public.charges where id = p_charge_id for update;

  if not found then
    raise exception 'Cobrança não encontrada';
  end if;

  if not public.has_company_role(v_charge.company_id, array['owner', 'admin', 'employee']::public.company_role[]) then
    raise exception 'Sem permissão para registrar pagamento nesta empresa';
  end if;

  if v_charge.status = 'paid' then
    raise exception 'Cobrança já está paga';
  end if;

  if v_charge.status = 'cancelled' then
    raise exception 'Cobrança cancelada não pode receber pagamento';
  end if;

  -- Reconciliação manual (ex.: dinheiro/Pix fora do gateway) numa cobrança
  -- vencida registra o valor com encargos, travando o cálculo de agora se
  -- ainda não tiver sido travado (evita gravar o valor original quando o
  -- que foi efetivamente recebido inclui multa/juros).
  select coalesce(updated_amount, amount) into v_amount
  from public.lock_late_charge_amount(v_charge.id);

  insert into public.payments (
    company_id, charge_id, provider, payment_method, installments,
    gross_amount, fee_amount, net_amount, status, paid_at
  ) values (
    v_charge.company_id, v_charge.id, 'manual', p_payment_method, coalesce(p_installments, 1),
    v_amount, 0, v_amount, 'approved', now()
  ) returning id into v_payment_id;

  v_receipt_no := 'REC-' || lpad(nextval('public.charge_number_seq')::text, 6, '0');

  insert into public.receipts (company_id, charge_id, payment_id, receipt_number, issued_at)
  values (v_charge.company_id, v_charge.id, v_payment_id, v_receipt_no, now())
  returning id into v_receipt_id;

  update public.charges
  set status = 'paid', paid_at = now()
  where id = v_charge.id;

  return query select v_charge.id, v_payment_id, v_receipt_id;
end;
$$;
comment on function public.register_manual_payment(uuid, public.payment_method_type, integer) is
  'Registra reconciliação manual de pagamento (uso interno do painel), gerando payment + receipt e atualizando a cobrança. Trava e usa o valor com encargos quando a cobrança está vencida.';

grant execute on function public.register_manual_payment(uuid, public.payment_method_type, integer) to authenticated;

-- Fim da migração.
