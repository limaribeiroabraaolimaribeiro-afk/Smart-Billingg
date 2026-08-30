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
-- CONCILIAÇÃO DE PAGAMENTO DIVERGENTE (checkout antigo pago após o
-- vencimento): a InfinitePay NÃO tem endpoint para cancelar/invalidar um
-- checkout já criado — confirmado na documentação oficial (a orientação é
-- sempre "gere um link novo e ignore o antigo"; ver ajuda.infinitepay.io e
-- infinitepay.io/checkout-documentacao). Isso significa que, depois de uma
-- cobrança vencer e ganhar um checkout novo com multa/juros, o link ANTIGO
-- (valor original) continua 100% pagável. Se alguém pagar por ele, o
-- dinheiro é real — nunca pode ser descartado só porque o valor não bate com
-- updated_amount. register_infinitepay_payment nunca levanta exceção para
-- dinheiro já confirmado pela InfinitePay: quando o valor ou o status da
-- cobrança não permite liquidar normalmente, grava o pagamento em
-- payment_reviews para conciliação manual — nunca perde o pagamento, nunca
-- marca como quitado algo que ficou menor que o valor atualizado, e nunca
-- duplica cobrança/checkout. Propositalmente NÃO adiciona um novo valor a
-- public.charge_status: ALTER TYPE ... ADD VALUE não pode ser referenciado
-- por nenhuma função na mesma transação em que é criado (o Postgres recusa
-- com "unsafe use of new enum value" a menos que o tipo tenha sido criado
-- nesta mesma transação) — exigiria rodar esta migração em duas etapas
-- manuais separadas. Em vez disso, o estado "requer revisão" é só a
-- EXISTÊNCIA de uma linha com status='pending_review' em payment_reviews
-- para aquela cobrança — charges.status nem chega a mudar.
--
-- Conteúdo:
--   1. Configuração por empresa (companies.late_fee_*).
--   2. Colunas de encargos em charges (updated_amount, late_fee_amount,
--      late_interest_amount, late_fee_calculated_at).
--   3. payment_reviews — fila de conciliação (criada ANTES de
--      calculate_late_charges, que já referencia a tabela).
--   4. calculate_late_charges() — cálculo puro, sem gravar nada. Congela o
--      snapshot quando pago/cancelado/em revisão.
--   5. lock_late_charge_amount() — trava o cálculo do dia em charges (só
--      service_role, chamada pelas Edge Functions antes de gerar checkout).
--   6. get_public_charge_by_token() — estendida com os campos de encargos e
--      has_pending_review.
--   7. register_infinitepay_payment() — reescrita para nunca descartar
--      dinheiro confirmado (ver nota de conciliação acima).
--   8. register_manual_payment() — passa a considerar updated_amount
--      (quando existir) como o valor esperado/recebido, preservando o
--      histórico de encargos já gravado.
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
-- 3. payment_reviews — fila de conciliação para pagamentos InfinitePay
--    confirmados que não batem com a cobrança (checkout antigo pago depois
--    de a cobrança vencer e ganhar multa/juros, cobrança cancelada/paga por
--    outra transação, etc.). Criada aqui (antes de calculate_late_charges)
--    porque essa função já referencia esta tabela — uma função não pode
--    referenciar uma tabela que ainda não existe no momento em que é criada.
-- ============================================================================
create table if not exists public.payment_reviews (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies (id) on delete cascade,
  charge_id                 uuid not null references public.charges (id) on delete cascade,
  provider                  text not null default 'infinitepay',
  provider_transaction_id   text not null,
  payment_method            public.payment_method_type not null,
  installments              integer not null default 1,
  expected_amount           numeric(12, 2) not null,
  paid_amount               numeric(12, 2) not null,
  reason                    text not null,
  status                    text not null default 'pending_review' check (status in ('pending_review', 'resolved')),
  notes                     text,
  receipt_url               text,
  raw_payload               jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table public.payment_reviews is 'Pagamentos InfinitePay confirmados via payment_check que não batem com o valor/estado esperado da cobrança. Nunca descartados — ficam aqui para conciliação manual. Nunca gravado a partir de valor calculado no navegador.';
comment on column public.payment_reviews.expected_amount is 'coalesce(charges.updated_amount, charges.amount) no momento em que o pagamento divergente chegou.';
comment on column public.payment_reviews.paid_amount is 'Valor efetivamente confirmado pela InfinitePay (payment_check), em reais.';
comment on column public.payment_reviews.reason is 'paid_less_than_expected | paid_more_than_expected | charge_cancelled | charge_already_paid_by_other_transaction.';
comment on column public.payment_reviews.status is 'pending_review = ainda não conciliado (é o que marca a cobrança como "requer revisão"). resolved = tratado manualmente (ver notes).';

create unique index if not exists payment_reviews_provider_transaction_unique
  on public.payment_reviews (provider, provider_transaction_id);
create index if not exists idx_payment_reviews_company on public.payment_reviews (company_id);
create index if not exists idx_payment_reviews_charge  on public.payment_reviews (charge_id);

drop trigger if exists trg_payment_reviews_updated_at on public.payment_reviews;
create trigger trg_payment_reviews_updated_at before update on public.payment_reviews
  for each row execute function public.set_updated_at();

alter table public.payment_reviews enable row level security;
revoke all on public.payment_reviews from anon, authenticated;

-- Dono/admin/funcionário podem VER a fila de revisão da própria empresa
-- (inclusive embedada via PostgREST em charges → payment_reviews, usada pelo
-- painel pra sinalizar "requer revisão"); só dono/admin podem atualizar, e
-- apenas status/notes (nunca os valores monetários ou a transação original)
-- — resolução de fato (registrar o ajuste financeiro) continua fora do
-- escopo desta migração.
grant select on public.payment_reviews to authenticated;
grant update (status, notes) on public.payment_reviews to authenticated;

drop policy if exists payment_reviews_select_company on public.payment_reviews;
create policy payment_reviews_select_company on public.payment_reviews for select to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists payment_reviews_update_company on public.payment_reviews;
create policy payment_reviews_update_company on public.payment_reviews for update to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin']::public.company_role[]))
  with check (public.has_company_role(company_id, array['owner', 'admin']::public.company_role[]));


-- ============================================================================
-- 4. calculate_late_charges — cálculo puro (não grava nada)
-- ----------------------------------------------------------------------------
-- Para cobranças pending/overdue sem revisão pendente: calcula em cima de
-- current_date (o valor muda dia a dia até alguém travá-lo com
-- lock_late_charge_amount). Para cobranças paid/cancelled OU com uma revisão
-- pendente em payment_reviews: devolve o que já está gravado na linha (o que
-- foi de fato cobrado/pago/travado), nunca recalcula — uma revisão pendente
-- também congela porque o valor esperado daquele momento já está registrado
-- em payment_reviews; deixar os juros continuarem correndo enquanto ninguém
-- resolveu a revisão só criaria um alvo móvel confuso pra conciliação.
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
  v_has_pending_review boolean;
begin
  select * into v_charge from public.charges where id = p_charge_id;
  if not found then
    raise exception 'Cobrança não encontrada';
  end if;

  select exists (
    select 1 from public.payment_reviews pr
    where pr.charge_id = p_charge_id and pr.status = 'pending_review'
  ) into v_has_pending_review;

  -- Pago/cancelado/com revisão pendente: devolve o snapshot já travado, nunca recalcula.
  if v_charge.status in ('paid', 'cancelled') or v_has_pending_review then
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
  'Calcula multa/juros de mora de uma cobrança (puro, não grava nada). Congela o valor após pago/cancelado/revisão pendente.';


-- ============================================================================
-- 5. lock_late_charge_amount — trava o cálculo do dia na própria cobrança
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
-- 6. get_public_charge_by_token — estendida com os campos de encargos e
--    has_pending_review
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
  late_interest_monthly_percent numeric,
  has_pending_review      boolean
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
      co.late_interest_monthly_percent,
      exists (
        select 1 from public.payment_reviews pr
        where pr.charge_id = v_charge_id and pr.status = 'pending_review'
      ) as has_pending_review
    from public.charges c
    left join public.clients cl on cl.id = c.client_id
    join public.companies co on co.id = c.company_id
    where c.id = v_charge_id;
end;
$$;
comment on function public.get_public_charge_by_token(uuid) is
  'Retorna dados públicos e seguros de UMA cobrança via public_token, sem exigir login, incluindo multa/juros calculados ao vivo e has_pending_review (pagamento confirmado com valor divergente, pendente de conciliação manual).';

grant execute on function public.get_public_charge_by_token(uuid) to anon, authenticated;


-- ============================================================================
-- 7. register_infinitepay_payment — reescrita para nunca descartar dinheiro
-- ----------------------------------------------------------------------------
-- Precisa DROP + CREATE (não CREATE OR REPLACE) porque a lista de colunas de
-- retorno mudou (ganhou review_id e outcome).
--
-- Ordem importa: a checagem de idempotência (transaction_nsu já processada,
-- como pagamento OU como revisão) vem sempre primeiro, antes de qualquer
-- decisão baseada em status — uma reentrega do webhook nunca deve tropeçar
-- numa exceção por causa de um status que mudou depois da primeira vez.
--
-- Só liquida normalmente (status='paid') quando a cobrança ainda podia
-- legitimamente ser paga E o valor confirmado bate exatamente com
-- coalesce(updated_amount, amount). Qualquer outro caso (valor menor/maior
-- que o esperado, cobrança já paga por outra transação, cobrança cancelada)
-- é dinheiro JÁ CONFIRMADO pela InfinitePay (payment_check rodou antes de
-- chamar esta função) — nunca vira exceção; vai para payment_reviews. Não
-- mexe em charges.status (ver nota de conciliação no cabeçalho do arquivo) —
-- "requer revisão" é detectado por quem lê a cobrança via EXISTS em
-- payment_reviews, não por um novo valor de status.
-- ============================================================================
drop function if exists public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
);

create function public.register_infinitepay_payment(
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
  review_id         uuid,
  already_processed boolean,
  outcome           text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge           public.charges%rowtype;
  v_existing_pay_id  uuid;
  v_existing_rec_id  uuid;
  v_existing_review  uuid;
  v_payment_id       uuid;
  v_receipt_id       uuid;
  v_review_id        uuid;
  v_receipt_no       text;
  v_gross_amount     numeric(12, 2);
  v_confirmed_amt    numeric(12, 2);
  v_expected_amt     numeric(12, 2);
  v_reason           text;
begin
  if p_transaction_nsu is null or length(trim(p_transaction_nsu)) = 0 then
    raise exception 'transaction_nsu é obrigatório';
  end if;

  select * into v_charge from public.charges where id = p_charge_id for update;

  if not found then
    raise exception 'Cobrança não encontrada';
  end if;

  -- Idempotência primeiro, sempre — tanto pra pagamento já liquidado quanto
  -- pra pagamento já sinalizado em payment_reviews.
  select p.id, r.id
    into v_existing_pay_id, v_existing_rec_id
  from public.payments p
  left join public.receipts r on r.payment_id = p.id
  where p.provider = 'infinitepay'
    and p.provider_transaction_id = p_transaction_nsu
  limit 1;

  if found then
    return query select v_existing_pay_id, v_existing_rec_id, null::uuid, true, 'already_settled';
    return;
  end if;

  select id into v_existing_review
  from public.payment_reviews
  where provider = 'infinitepay'
    and provider_transaction_id = p_transaction_nsu
  limit 1;

  if found then
    return query select null::uuid, null::uuid, v_existing_review, true, 'already_flagged';
    return;
  end if;

  v_confirmed_amt := round((p_amount_cents::numeric) / 100.0, 2);
  v_expected_amt := coalesce(v_charge.updated_amount, v_charge.amount);

  if v_charge.status not in ('paid', 'cancelled') and v_confirmed_amt = v_expected_amt then
    v_gross_amount := v_confirmed_amt;

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

    return query select v_payment_id, v_receipt_id, null::uuid, false, 'settled';
    return;
  end if;

  -- Dinheiro real confirmado que não se encaixa na liquidação normal —
  -- registra para revisão em vez de levantar exceção (o que faria o webhook
  -- falhar e a InfinitePay desistir depois de algumas tentativas, perdendo
  -- o rastro do pagamento). charges.status NÃO muda aqui — ver cabeçalho.
  v_reason := case
    when v_charge.status = 'cancelled' then 'charge_cancelled'
    when v_charge.status = 'paid' then 'charge_already_paid_by_other_transaction'
    when v_confirmed_amt < v_expected_amt then 'paid_less_than_expected'
    else 'paid_more_than_expected'
  end;

  insert into public.payment_reviews (
    company_id, charge_id, provider, provider_transaction_id, payment_method,
    installments, expected_amount, paid_amount, reason, receipt_url, raw_payload
  ) values (
    v_charge.company_id, v_charge.id, 'infinitepay', p_transaction_nsu, p_payment_method,
    coalesce(p_installments, 1), v_expected_amt, v_confirmed_amt, v_reason, p_receipt_url, p_raw_payload
  ) returning id into v_review_id;

  return query select null::uuid, null::uuid, v_review_id, false, 'flagged_for_review';
end;
$$;
comment on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) is 'Registra pagamento confirmado da InfinitePay (webhook ou check-infinitepay-payment) de forma atômica e idempotente por transaction_nsu. Nunca descarta dinheiro confirmado: quando o valor ou o status da cobrança não permite liquidar normalmente, grava em payment_reviews em vez de levantar exceção.';

revoke all on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) from public, anon, authenticated;

grant execute on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) to service_role;


-- ============================================================================
-- 8. register_manual_payment — passa a considerar updated_amount (quando
--    existir) como o valor esperado/pago.
-- ----------------------------------------------------------------------------
-- Para cobranças que nunca tiveram encargos calculados, updated_amount é
-- null e coalesce(...) devolve amount — comportamento idêntico ao atual,
-- zero regressão pra cobranças em dia.
-- ============================================================================
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
