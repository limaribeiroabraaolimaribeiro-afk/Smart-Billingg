-- ============================================================================
-- Smart Billing — Integração InfinitePay (Checkout Integrado)
-- ----------------------------------------------------------------------------
-- Migração idempotente: pode ser executada quantas vezes for necessário no
-- SQL Editor do Supabase sem apagar dados existentes e sem gerar erro de
-- "já existe". Rode o arquivo inteiro de uma vez, depois de já ter rodado
-- sql/supabase_schema.sql pelo menos uma vez.
--
-- Este arquivo NÃO altera register_manual_payment() nem nenhuma tabela ou
-- policy do fluxo de pagamento manual já existente.
--
-- Conteúdo:
--   1. Índice único parcial para não processar a mesma transação duas vezes.
--   2. Reforço de unicidade de webhook_events por (provider, event_id).
--   3. Função atômica register_infinitepay_payment(...), usada pelas Edge
--      Functions infinitepay-webhook e check-infinitepay-payment.
-- ============================================================================


-- ============================================================================
-- 1. ÍNDICE ÚNICO — evita processar a mesma transação InfinitePay duas vezes
-- ============================================================================
create unique index if not exists payments_infinitepay_transaction_unique
on public.payments (provider, provider_transaction_id)
where provider_transaction_id is not null;


-- ============================================================================
-- 2. REFORÇO DE UNICIDADE — webhook_events por (provider, event_id)
-- ----------------------------------------------------------------------------
-- A tabela já foi criada em sql/supabase_schema.sql com
-- `unique (provider, event_id)` na própria definição da tabela. O índice
-- abaixo é redundante em condições normais, mas garante a unicidade mesmo se
-- o banco tiver sido criado/alterado fora do fluxo padrão deste projeto.
-- ============================================================================
create unique index if not exists webhook_events_provider_event_unique
on public.webhook_events (provider, event_id);


-- ============================================================================
-- 3. register_infinitepay_payment — registro atômico de pagamento InfinitePay
-- ----------------------------------------------------------------------------
-- Chamada exclusivamente pelas Edge Functions infinitepay-webhook e
-- check-infinitepay-payment (via service_role). Nunca deve ser exposta a
-- anon/authenticated — só o backend confia no resultado do payment_check
-- da InfinitePay antes de chamar esta função.
--
-- p_amount_cents / p_paid_amount_cents chegam em CENTAVOS (formato da API da
-- InfinitePay). O banco continua guardando valores em reais (numeric), então
-- a conversão acontece aqui, na fronteira entre a API externa e o schema.
--
-- fee_amount/net_amount seguem o mesmo padrão de register_manual_payment():
-- como a InfinitePay não informa taxas de forma explícita neste payload,
-- fee_amount = 0 e net_amount = gross_amount (nenhuma dedução é inventada).
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

  if v_confirmed_amt <> v_charge.amount then
    raise exception 'Valor divergente: confirmado % , esperado %', v_confirmed_amt, v_charge.amount;
  end if;

  v_gross_amount := v_charge.amount;

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
) is 'Registra pagamento confirmado da InfinitePay (webhook ou check-infinitepay-payment) de forma atômica e idempotente por transaction_nsu.';

-- Somente as Edge Functions (via service_role) podem chamar esta função.
revoke all on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) from public, anon, authenticated;

grant execute on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) to service_role;

-- Fim da migração.
