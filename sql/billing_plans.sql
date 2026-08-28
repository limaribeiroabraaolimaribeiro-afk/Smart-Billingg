-- ============================================================================
-- Smart Billing — Planos, Ofertas e Assinaturas (billing_plans / plan_offers /
-- client_subscriptions)
-- ----------------------------------------------------------------------------
-- Migração idempotente: pode ser executada quantas vezes for necessário no
-- SQL Editor do Supabase sem apagar dados existentes e sem gerar erro de
-- "já existe". Rode o arquivo inteiro de uma vez, depois de já ter rodado
-- sql/supabase_schema.sql, sql/infinitepay_integration.sql e
-- sql/whatsapp_agent.sql pelo menos uma vez (depende de: public.companies,
-- public.clients, public.charges, public.payments, public.is_company_member,
-- public.has_company_role, public.set_updated_at,
-- public.register_infinitepay_payment, public.register_manual_payment,
-- public.whatsapp_outbox/whatsapp_message_type — usados só pela notificação
-- de renovação mensal, seção 12).
--
-- NÃO cria um sistema paralelo de pagamento: um plano selecionado sempre
-- vira uma cobrança normal na tabela charges, que segue o MESMO fluxo já
-- existente (checkout InfinitePay → webhook → payments/receipts). Esta
-- migração só adiciona 3 tabelas novas + 3 colunas opcionais em charges +
-- funções que orquestram esse fluxo, sem alterar o comportamento de
-- nenhuma cobrança avulsa já existente.
--
-- Conteúdo:
--   1. Enums (billing_plan_type, plan_offer_status, client_subscription_status)
--   2. Tabela billing_plans
--   3. Tabela plan_offers
--   4. Tabela client_subscriptions
--   5. Colunas opcionais em charges (plan_id, offer_id, subscription_id)
--   6. Índices
--   7. Triggers de updated_at
--   8. RLS + policies (mesmo padrão de is_company_member/has_company_role)
--   9. Função pública segura get_public_plan_offer_by_token (via token)
--  10. Função select_plan_offer (service_role only — cria a cobrança real)
--  11. Ativação/renovação de assinatura ao confirmar pagamento (estende
--      register_infinitepay_payment e register_manual_payment via
--      CREATE OR REPLACE, mesma assinatura — nenhuma Edge Function precisa
--      mudar para isso funcionar)
--  12. Funções de renovação mensal (service_role only, uso do worker)
--  13. Funções de gestão de planos/ofertas para o painel (authenticated)
-- ============================================================================


-- ============================================================================
-- 1. ENUMS
-- ============================================================================
do $$ begin
  create type public.billing_plan_type as enum ('one_time', 'recurring_monthly');
exception when duplicate_object then null; end $$;

-- Nota de design: diferente do pedido original, NÃO existe o status
-- armazenado 'expired' aqui — segue o mesmo padrão já usado por
-- charges.status (que também nunca grava 'overdue': ele é sempre computado
-- comparando due_date com a data atual). Uma oferta "expirada" é
-- simplesmente status='active' com expires_at no passado — computado em
-- get_public_plan_offer_by_token()/list para o painel, sem precisar de um
-- cron que fique atualizando o status. O comportamento observável (Teste 8:
-- "oferta expirada não pode ser usada") é o mesmo; só a forma de
-- armazenamento é que segue o precedente já estabelecido no projeto.
do $$ begin
  create type public.plan_offer_status as enum ('active', 'selected', 'cancelled');
exception when duplicate_object then null; end $$;

-- Já client_subscriptions.status É armazenado com todos os 5 valores
-- pedidos, porque aqui o estado é genuinely operacional (depende do
-- resultado da rotina de renovação, não é derivável só de uma data).
do $$ begin
  create type public.client_subscription_status as enum ('pending', 'active', 'overdue', 'cancelled', 'expired');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2. billing_plans — planos comerciais oferecidos por uma empresa
-- ============================================================================
create table if not exists public.billing_plans (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete cascade,
  name                text not null check (length(trim(name)) > 0),
  description         text,
  short_description   text,
  amount              numeric(12, 2) not null check (amount > 0),
  -- Preço "de referência" (antes do desconto) — opcional, só usado para
  -- exibir o comparativo "de R$ X por R$ Y". Nunca pode ser menor que o
  -- preço real cobrado.
  reference_amount    numeric(12, 2) check (reference_amount is null or reference_amount >= amount),
  discount_percent    numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  -- Para billing_type = 'one_time': duração total do serviço, em meses
  -- (12 = anual, 24 = 2 anos). Para 'recurring_monthly': tamanho do ciclo de
  -- cobrança em meses (sempre 1 no caso do plano "Mensal" padrão, mas o
  -- campo aceita outros ciclos recorrentes sem precisar de coluna nova).
  duration_months     integer not null check (duration_months > 0),
  billing_type        public.billing_plan_type not null,
  badge                text,
  featured            boolean not null default false,
  -- Mesmo formato/checagem já usado em charges.payment_methods.
  payment_methods     jsonb not null default '["pix", "cartao"]'::jsonb
                        check (payment_methods <@ '["pix", "cartao"]'::jsonb),
  -- Teto de 12x (não 24, mesmo em planos de 24 meses) — ver seção 10 e
  -- docs/PLANOS_E_ASSINATURAS.md para a limitação real da InfinitePay.
  max_installments    integer not null default 1 check (max_installments between 1 and 12),
  active              boolean not null default true,
  sort_order          integer not null default 0,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, name)
);
comment on table public.billing_plans is 'Planos comerciais (mensal/anual/2 anos/etc.) de uma empresa. Selecionar um plano gera uma cobrança normal em charges — nunca um pagamento paralelo.';


-- ============================================================================
-- 3. plan_offers — oferta de planos enviada a um cliente específico
-- ============================================================================
create table if not exists public.plan_offers (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete cascade,
  client_id           uuid not null references public.clients (id) on delete cascade,
  -- Token público imprevisível (UUID v4 aleatório do pgcrypto) — é o único
  -- identificador aceito pela leitura pública (seção 9). Nunca sequencial.
  public_token        uuid not null default gen_random_uuid() unique,
  title               text,
  message             text,
  -- Quais planos aparecem nesta oferta, na ordem em que devem ser exibidos.
  -- Validado (todos pertencem à mesma empresa e estão ativos) em
  -- create_plan_offer() — ver seção 13 — nunca aceito sem validação.
  plan_ids            uuid[] not null check (array_length(plan_ids, 1) > 0),
  status              public.plan_offer_status not null default 'active',
  expires_at          timestamptz not null check (expires_at > created_at),
  selected_plan_id    uuid references public.billing_plans (id) on delete set null,
  charge_id           uuid references public.charges (id) on delete set null,
  selected_at         timestamptz,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.plan_offers is 'Oferta de planos enviada a um cliente via link público (public_token). status=selected é setado atomicamente por select_plan_offer() — nunca pelo frontend.';


-- ============================================================================
-- 4. client_subscriptions — assinatura ativa/histórica de um cliente
-- ============================================================================
create table if not exists public.client_subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete cascade,
  client_id           uuid not null references public.clients (id) on delete cascade,
  plan_id             uuid not null references public.billing_plans (id) on delete restrict,
  initial_charge_id   uuid references public.charges (id) on delete set null,
  status              public.client_subscription_status not null default 'pending',
  starts_at           timestamptz,
  ends_at             timestamptz,
  next_billing_at     timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.client_subscriptions is 'Assinatura de um cliente a um plano. Só vira status=active depois que o pagamento da cobrança inicial é confirmado (InfinitePay ou reconciliação manual) — nunca ao simplesmente clicar no plano.';


-- ============================================================================
-- 5. charges — colunas opcionais (retrocompatíveis) ligando a plano/oferta/assinatura
-- ============================================================================
alter table public.charges add column if not exists plan_id         uuid references public.billing_plans (id) on delete set null;
alter table public.charges add column if not exists offer_id        uuid references public.plan_offers (id) on delete set null;
alter table public.charges add column if not exists subscription_id uuid references public.client_subscriptions (id) on delete set null;

comment on column public.charges.plan_id is 'Plano de origem, se esta cobrança veio de uma oferta de plano selecionada pelo cliente. NULL para cobranças avulsas normais (comportamento padrão, retrocompatível).';
comment on column public.charges.offer_id is 'Oferta de origem, se aplicável. NULL para cobranças avulsas normais.';
comment on column public.charges.subscription_id is 'Assinatura à qual esta cobrança pertence (inicial ou renovação mensal). NULL para cobranças avulsas normais.';


-- ============================================================================
-- 6. ÍNDICES
-- ============================================================================
create index if not exists idx_billing_plans_company          on public.billing_plans (company_id);
create index if not exists idx_billing_plans_company_active    on public.billing_plans (company_id, active);

create index if not exists idx_plan_offers_company             on public.plan_offers (company_id);
create index if not exists idx_plan_offers_client               on public.plan_offers (client_id);
create index if not exists idx_plan_offers_status_active        on public.plan_offers (company_id) where status = 'active';

create index if not exists idx_client_subscriptions_company     on public.client_subscriptions (company_id);
create index if not exists idx_client_subscriptions_client      on public.client_subscriptions (client_id);
create index if not exists idx_client_subscriptions_status      on public.client_subscriptions (company_id, status);
-- Usado pela rotina de renovação mensal para achar assinaturas a vencer.
create index if not exists idx_client_subscriptions_next_billing on public.client_subscriptions (next_billing_at) where status = 'active';

create index if not exists idx_charges_plan                     on public.charges (plan_id) where plan_id is not null;
create index if not exists idx_charges_offer                    on public.charges (offer_id) where offer_id is not null;
create index if not exists idx_charges_subscription             on public.charges (subscription_id) where subscription_id is not null;


-- ============================================================================
-- 7. TRIGGERS DE updated_at (reaproveita public.set_updated_at() já existente)
-- ============================================================================
drop trigger if exists trg_billing_plans_updated_at on public.billing_plans;
create trigger trg_billing_plans_updated_at before update on public.billing_plans
  for each row execute function public.set_updated_at();

drop trigger if exists trg_plan_offers_updated_at on public.plan_offers;
create trigger trg_plan_offers_updated_at before update on public.plan_offers
  for each row execute function public.set_updated_at();

drop trigger if exists trg_client_subscriptions_updated_at on public.client_subscriptions;
create trigger trg_client_subscriptions_updated_at before update on public.client_subscriptions
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 8. ROW LEVEL SECURITY — mesmo padrão de is_company_member/has_company_role
--    já usado em todas as outras tabelas (nenhuma policy usa "true" solto).
-- ============================================================================

-- ---------------- billing_plans ----------------
alter table public.billing_plans enable row level security;

-- RLS por si só não concede acesso à tabela — sem este grant, todo
-- authenticated recebe "permission denied for table billing_plans" mesmo
-- com as policies abaixo corretas. As policies continuam sendo quem decide
-- quais linhas cada usuário enxerga/altera; o grant só libera a tabela.
grant select, insert, update, delete on table public.billing_plans to authenticated;

drop policy if exists billing_plans_select_members on public.billing_plans;
create policy billing_plans_select_members on public.billing_plans
  for select using (public.is_company_member(public.billing_plans.company_id));

drop policy if exists billing_plans_insert_managers on public.billing_plans;
create policy billing_plans_insert_managers on public.billing_plans
  for insert with check (public.has_company_role(public.billing_plans.company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists billing_plans_update_managers on public.billing_plans;
create policy billing_plans_update_managers on public.billing_plans
  for update using (public.has_company_role(public.billing_plans.company_id, array['owner', 'admin', 'employee']::public.company_role[]))
  with check (public.has_company_role(public.billing_plans.company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists billing_plans_delete_managers on public.billing_plans;
create policy billing_plans_delete_managers on public.billing_plans
  for delete using (public.has_company_role(public.billing_plans.company_id, array['owner', 'admin']::public.company_role[]));

-- Não existe policy pública de SELECT em billing_plans: o acesso da página
-- pública da oferta é feito exclusivamente via get_public_plan_offer_by_token.

-- ---------------- plan_offers ----------------
alter table public.plan_offers enable row level security;

grant select, insert, update, delete on table public.plan_offers to authenticated;

drop policy if exists plan_offers_select_members on public.plan_offers;
create policy plan_offers_select_members on public.plan_offers
  for select using (public.is_company_member(public.plan_offers.company_id));

drop policy if exists plan_offers_insert_managers on public.plan_offers;
create policy plan_offers_insert_managers on public.plan_offers
  for insert with check (public.has_company_role(public.plan_offers.company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists plan_offers_update_managers on public.plan_offers;
create policy plan_offers_update_managers on public.plan_offers
  for update using (public.has_company_role(public.plan_offers.company_id, array['owner', 'admin', 'employee']::public.company_role[]))
  with check (public.has_company_role(public.plan_offers.company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists plan_offers_delete_managers on public.plan_offers;
create policy plan_offers_delete_managers on public.plan_offers
  for delete using (public.has_company_role(public.plan_offers.company_id, array['owner', 'admin']::public.company_role[]));

-- Não existe policy pública de SELECT em plan_offers: o cliente final nunca
-- lê a tabela diretamente — só via get_public_plan_offer_by_token. A
-- seleção do plano (UPDATE de status/selected_plan_id/charge_id) é feita
-- exclusivamente por select_plan_offer() (security definer, service_role),
-- nunca por UPDATE direto do frontend — não há policy de UPDATE para anon.

-- ---------------- client_subscriptions ----------------
alter table public.client_subscriptions enable row level security;

-- Só select: escrita é exclusiva das funções security definer abaixo (ver
-- comentário mais abaixo) — authenticated nunca precisa de insert/update/delete
-- direto nesta tabela.
grant select on table public.client_subscriptions to authenticated;

drop policy if exists client_subscriptions_select_members on public.client_subscriptions;
create policy client_subscriptions_select_members on public.client_subscriptions
  for select using (public.is_company_member(public.client_subscriptions.company_id));

-- Sem policy de INSERT/UPDATE/DELETE para authenticated: assinaturas só são
-- criadas/avançadas pelas funções security definer abaixo (select_plan_offer,
-- a ativação em register_infinitepay_payment/register_manual_payment, e a
-- rotina de renovação) — nunca escritas diretamente pelo painel. Cancelar
-- uma assinatura também passa por uma função dedicada (seção 13), que valida
-- o papel do usuário antes de gravar.


-- ============================================================================
-- 9. get_public_plan_offer_by_token — leitura pública e segura (via token)
-- ----------------------------------------------------------------------------
-- Mesma filosofia de get_public_charge_by_token/get_public_receipt_by_token:
-- security definer, grant só para anon/authenticated, retorna só as colunas
-- necessárias para renderizar a página pública — nunca expõe company_id,
-- client_id internos, nem dados de outras ofertas/planos da empresa.
-- Calcula is_expired/already_selected aqui (nunca no frontend) para a página
-- pública decidir corretamente qual estado mostrar.
-- ============================================================================
create or replace function public.get_public_plan_offer_by_token(p_token uuid)
returns table (
  offer_id            uuid,
  title               text,
  message             text,
  status              public.plan_offer_status,
  is_expired          boolean,
  expires_at          timestamptz,
  client_name         text,
  company_name        text,
  selected_plan_name  text,
  charge_status       public.charge_status,
  charge_public_token uuid,
  plans               jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.title,
    o.message,
    o.status,
    (o.status = 'active' and o.expires_at < now()) as is_expired,
    o.expires_at,
    cl.name as client_name,
    co.name as company_name,
    bp_sel.name as selected_plan_name,
    ch.status as charge_status,
    ch.public_token as charge_public_token,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', bp.id,
        'name', bp.name,
        'description', bp.description,
        'short_description', bp.short_description,
        'amount', bp.amount,
        'reference_amount', bp.reference_amount,
        'discount_percent', bp.discount_percent,
        'duration_months', bp.duration_months,
        'billing_type', bp.billing_type,
        'badge', bp.badge,
        'featured', bp.featured,
        'payment_methods', bp.payment_methods,
        'max_installments', bp.max_installments
      ) order by bp.sort_order, bp.amount)
      from public.billing_plans bp
      where bp.id = any (o.plan_ids)
        and bp.company_id = o.company_id
        and bp.active = true
    ), '[]'::jsonb) as plans
  from public.plan_offers o
  join public.clients cl on cl.id = o.client_id
  join public.companies co on co.id = o.company_id
  left join public.billing_plans bp_sel on bp_sel.id = o.selected_plan_id
  left join public.charges ch on ch.id = o.charge_id
  where o.public_token = p_token;
$$;
comment on function public.get_public_plan_offer_by_token(uuid) is 'Retorna dados públicos e seguros de UMA oferta de planos via public_token, sem exigir login. Nunca expõe company_id/client_id internos.';

grant execute on function public.get_public_plan_offer_by_token(uuid) to anon, authenticated;


-- ============================================================================
-- 10. select_plan_offer — cliente escolhe um plano (cria a cobrança REAL)
-- ----------------------------------------------------------------------------
-- Restrita a service_role: só a Edge Function pública que expõe esta ação
-- (chamada pela página oferta.html) pode executá-la. O frontend nunca chama
-- esta função diretamente nem envia preço/desconto/duração — só
-- p_offer_token (o token da oferta) e p_plan_id (qual dos planos ofertados
-- foi escolhido). TUDO o mais (valor, parcelas, forma de pagamento, duração)
-- é buscado aqui, no banco, a partir de billing_plans.
--
-- Concorrência/idempotência (clique duplo, duas abas, F5 durante o clique):
-- o "claim" da oferta é um único UPDATE ... WHERE status = 'active' RETURNING
-- — atômico por definição no Postgres (a segunda transação concorrente só
-- executa depois que a primeira commita, e nesse momento o WHERE já não
-- casa mais, porque o status não é mais 'active'). Por isso a cobrança só é
-- criada DEPOIS que o claim confirma sucesso — nunca antes. Se a oferta já
-- foi selecionada (por esta ou por outra requisição concorrente), devolve os
-- dados da cobrança JÁ criada em vez de criar uma segunda — testado
-- empiricamente com sessões concorrentes reais (ver relatório final).
-- ============================================================================
create or replace function public.select_plan_offer(
  p_offer_token uuid,
  p_plan_id     uuid
)
returns table (
  result              text,   -- 'created' | 'already_selected' | 'not_found' | 'expired' | 'invalid_plan'
  charge_id           uuid,
  charge_public_token uuid,
  subscription_id     uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer         public.plan_offers%rowtype;
  v_plan          public.billing_plans%rowtype;
  v_client        public.clients%rowtype;
  v_claimed       public.plan_offers%rowtype;
  v_charge_id     uuid;
  v_charge_token  uuid;
  v_subscription  uuid;
  v_due_date      date;
begin
  select * into v_offer from public.plan_offers where public_token = p_offer_token for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- Oferta já usada (por esta mesma requisição ou por uma concorrente que já
  -- comitou) — devolve a cobrança já existente em vez de erro, para o
  -- clique duplo/F5 ser inofensivo do ponto de vista do cliente final.
  if v_offer.status = 'selected' then
    return query select 'already_selected'::text, v_offer.charge_id, (select public_token from public.charges where id = v_offer.charge_id), (select id from public.client_subscriptions where initial_charge_id = v_offer.charge_id);
    return;
  end if;

  if v_offer.status = 'cancelled' then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v_offer.expires_at < now() then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if not (p_plan_id = any (v_offer.plan_ids)) then
    return query select 'invalid_plan'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select * into v_plan
  from public.billing_plans
  where id = p_plan_id and company_id = v_offer.company_id and active = true;

  if not found then
    return query select 'invalid_plan'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select * into v_client from public.clients where id = v_offer.client_id;

  -- Claim atômico: só uma execução (concorrente ou não) consegue passar
  -- daqui. update ... where status = 'active' garante isso mesmo sob
  -- concorrência real (linha já travada pelo "for update" acima).
  update public.plan_offers
  set status = 'selected', selected_plan_id = v_plan.id, selected_at = now()
  where id = v_offer.id and status = 'active'
  returning * into v_claimed;

  if not found then
    -- Corrida perdida entre o select acima e este update (extremamente
    -- raro, coberto pelo FOR UPDATE, mas tratado de toda forma): trata como
    -- already_selected.
    return query select 'already_selected'::text, (select charge_id from public.plan_offers where id = v_offer.id), (select public_token from public.charges where id = (select charge_id from public.plan_offers where id = v_offer.id)), null::uuid;
    return;
  end if;

  -- due_date da cobrança inicial: hoje (o cliente está pagando agora). Para
  -- planos recorrentes mensais isso também define a "âncora" do primeiro
  -- ciclo antes da confirmação do pagamento.
  v_due_date := current_date;

  insert into public.charges (
    company_id, client_id, description, amount, due_date, status,
    payment_methods, max_installments, plan_id, offer_id
  ) values (
    v_offer.company_id, v_offer.client_id,
    'Plano ' || v_plan.name,
    v_plan.amount, v_due_date, 'pending',
    v_plan.payment_methods, v_plan.max_installments, v_plan.id, v_offer.id
  )
  returning id, public_token into v_charge_id, v_charge_token;

  insert into public.client_subscriptions (
    company_id, client_id, plan_id, initial_charge_id, status
  ) values (
    v_offer.company_id, v_offer.client_id, v_plan.id, v_charge_id, 'pending'
  )
  returning id into v_subscription;

  update public.charges set subscription_id = v_subscription where id = v_charge_id;
  update public.plan_offers set charge_id = v_charge_id where id = v_offer.id;

  return query select 'created'::text, v_charge_id, v_charge_token, v_subscription;
end;
$$;
comment on function public.select_plan_offer(uuid, uuid) is 'Cliente escolhe um plano de uma oferta pública: cria a cobrança REAL (charges) e a assinatura em status pending. Nunca aceita preço/desconto do chamador — sempre busca de billing_plans. Restrita a service_role (chamada só pela Edge Function pública select-plan-offer).';

revoke all on function public.select_plan_offer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.select_plan_offer(uuid, uuid) to service_role;


-- ============================================================================
-- 11. ATIVAÇÃO/RENOVAÇÃO DE ASSINATURA AO CONFIRMAR PAGAMENTO
-- ----------------------------------------------------------------------------
-- public.activate_subscription_on_charge_paid(p_charge_id) é chamada pelas
-- DUAS funções que marcam uma cobrança como paga (register_infinitepay_payment
-- e register_manual_payment), logo depois do "update charges set status =
-- 'paid'" que cada uma já fazia. Se a cobrança não pertence a nenhuma
-- assinatura (subscription_id is null — o caso de toda cobrança avulsa
-- normal), a função não faz nada e retorna imediatamente. NUNCA é chamada a
-- partir do clique do cliente em "Escolher plano" — só a partir do
-- pagamento confirmado, que é exatamente onde register_infinitepay_payment/
-- register_manual_payment já são chamadas hoje.
-- ============================================================================
create or replace function public.activate_subscription_on_charge_paid(p_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge  public.charges%rowtype;
  v_sub     public.client_subscriptions%rowtype;
  v_plan    public.billing_plans%rowtype;
begin
  select * into v_charge from public.charges where id = p_charge_id;
  if not found or v_charge.subscription_id is null then
    return;
  end if;

  select * into v_sub from public.client_subscriptions where id = v_charge.subscription_id for update;
  if not found then
    return;
  end if;

  select * into v_plan from public.billing_plans where id = v_sub.plan_id;
  if not found then
    return;
  end if;

  if v_sub.initial_charge_id = p_charge_id then
    -- Cobrança INICIAL da assinatura: primeira ativação.
    if v_plan.billing_type = 'one_time' then
      update public.client_subscriptions
      set status = 'active',
          starts_at = now(),
          ends_at = now() + (v_plan.duration_months || ' months')::interval,
          next_billing_at = null
      where id = v_sub.id;
    else -- recurring_monthly
      update public.client_subscriptions
      set status = 'active',
          starts_at = now(),
          ends_at = null,
          next_billing_at = now() + (v_plan.duration_months || ' months')::interval
      where id = v_sub.id;
    end if;
  else
    -- Cobrança de RENOVAÇÃO (mensal): avança next_billing_at a partir do
    -- valor anterior (âncora preservada, ex.: sempre dia 28), não a partir
    -- de "agora" — evita deriva de data por pagamentos feitos com atraso.
    update public.client_subscriptions
    set status = 'active',
        next_billing_at = coalesce(next_billing_at, now()) + (v_plan.duration_months || ' months')::interval
    where id = v_sub.id;
  end if;
end;
$$;
comment on function public.activate_subscription_on_charge_paid(uuid) is 'Ativa/renova a assinatura ligada a uma cobrança recém-paga. No-op se a cobrança não pertence a nenhuma assinatura. Chamada por register_infinitepay_payment e register_manual_payment.';

revoke all on function public.activate_subscription_on_charge_paid(uuid) from public, anon, authenticated;
grant execute on function public.activate_subscription_on_charge_paid(uuid) to service_role;

-- ---- register_infinitepay_payment: CREATE OR REPLACE, mesma assinatura ----
-- Idêntica à versão em sql/infinitepay_integration.sql, só com UMA linha
-- nova (chamada a activate_subscription_on_charge_paid) logo após o update
-- de charges.status='paid'. Nada mais muda — o comportamento para cobranças
-- sem plano permanece exatamente igual.
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

  -- ÚNICA linha nova em relação a sql/infinitepay_integration.sql: ativa a
  -- assinatura, se esta cobrança pertencer a uma (no-op caso contrário).
  perform public.activate_subscription_on_charge_paid(v_charge.id);

  return query select v_payment_id, v_receipt_id, false;
end;
$$;
comment on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) is 'Registra pagamento confirmado da InfinitePay (webhook ou check-infinitepay-payment) de forma atômica e idempotente por transaction_nsu. Ativa/renova assinatura quando a cobrança pertence a um plano.';

revoke all on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) from public, anon, authenticated;
grant execute on function public.register_infinitepay_payment(
  uuid, text, public.payment_method_type, integer, bigint, bigint, text, jsonb
) to service_role;

-- ---- register_manual_payment: CREATE OR REPLACE, mesma assinatura ----
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

  insert into public.payments (
    company_id, charge_id, provider, payment_method, installments,
    gross_amount, fee_amount, net_amount, status, paid_at
  ) values (
    v_charge.company_id, v_charge.id, 'manual', p_payment_method, coalesce(p_installments, 1),
    v_charge.amount, 0, v_charge.amount, 'approved', now()
  ) returning id into v_payment_id;

  v_receipt_no := 'REC-' || lpad(nextval('public.charge_number_seq')::text, 6, '0');

  insert into public.receipts (company_id, charge_id, payment_id, receipt_number, issued_at)
  values (v_charge.company_id, v_charge.id, v_payment_id, v_receipt_no, now())
  returning id into v_receipt_id;

  update public.charges
  set status = 'paid', paid_at = now()
  where id = v_charge.id;

  -- ÚNICA linha nova em relação a sql/supabase_schema.sql.
  perform public.activate_subscription_on_charge_paid(v_charge.id);

  return query select v_charge.id, v_payment_id, v_receipt_id;
end;
$$;
comment on function public.register_manual_payment(uuid, public.payment_method_type, integer) is
  'Registra reconciliação manual de pagamento (uso interno do painel), gerando payment + receipt e atualizando a cobrança. Ativa/renova assinatura quando a cobrança pertence a um plano.';

grant execute on function public.register_manual_payment(uuid, public.payment_method_type, integer) to authenticated;


-- ============================================================================
-- 12. RENOVAÇÃO MENSAL — funções de uso exclusivo do worker (service_role)
-- ----------------------------------------------------------------------------
-- A InfinitePay não tem (nesta integração) cobrança recorrente automática
-- confirmada — só o endpoint de link avulso (ver seção 10/_shared/infinitepay.ts).
-- Por isso o Smart Billing controla a recorrência mensal sozinho: o worker
-- já existente (mesmo processo que já faz polling de lembretes, ver
-- smart-billing-agent/) chama list_due_subscription_renewals() a cada ciclo
-- e, para cada linha, create_subscription_renewal_charge() — que é
-- idempotente por ciclo via UNIQUE (subscription_id, billing_period) abaixo,
-- então rodar o worker várias vezes, reiniciar a VPS, etc. nunca gera duas
-- cobranças para o mesmo mês.
-- ============================================================================

-- Evita duas cobranças de renovação para o mesmo ciclo (mês) da mesma
-- assinatura, mesmo sob execuções concorrentes do worker — mesmo mecanismo
-- de proteção (unique index + ON CONFLICT) já usado em whatsapp_outbox.idempotency_key.
alter table public.charges add column if not exists renewal_period date;
comment on column public.charges.renewal_period is 'Para cobranças de renovação mensal (subscription_id preenchido, charge != initial_charge_id): o 1º dia do mês/ciclo que esta cobrança renova. NULL para todas as outras cobranças. Par (subscription_id, renewal_period) é único — garante no máximo 1 cobrança de renovação por ciclo.';

create unique index if not exists idx_charges_subscription_renewal_period
  on public.charges (subscription_id, renewal_period)
  where subscription_id is not null and renewal_period is not null;

create or replace function public.list_due_subscription_renewals(p_company_id uuid, p_limit integer default 50)
returns table (
  subscription_id   uuid,
  client_id         uuid,
  client_name       text,
  client_whatsapp   text,
  client_email      text,
  plan_id           uuid,
  plan_name         text,
  plan_amount       numeric,
  plan_payment_methods jsonb,
  plan_max_installments integer,
  next_billing_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id, s.client_id, cl.name, cl.whatsapp, cl.email,
    s.plan_id, bp.name, bp.amount, bp.payment_methods, bp.max_installments,
    s.next_billing_at
  from public.client_subscriptions s
  join public.billing_plans bp on bp.id = s.plan_id
  join public.clients cl on cl.id = s.client_id
  where s.company_id = p_company_id
    and s.status = 'active'
    and bp.billing_type = 'recurring_monthly'
    and s.next_billing_at is not null
    and s.next_billing_at <= now()
    -- Ainda não existe cobrança para este ciclo (checagem redundante com o
    -- unique index abaixo, mas evita até tentar o insert desnecessariamente).
    and not exists (
      select 1 from public.charges c
      where c.subscription_id = s.id
        and c.renewal_period = date_trunc('month', s.next_billing_at)::date
    )
  order by s.next_billing_at asc
  limit greatest(coalesce(p_limit, 50), 0);
$$;
comment on function public.list_due_subscription_renewals(uuid, integer) is 'Lista assinaturas mensais com renovação vencida (next_billing_at <= agora) que ainda não têm cobrança gerada para o ciclo. Uso exclusivo do worker via service_role.';

revoke all on function public.list_due_subscription_renewals(uuid, integer) from public, anon, authenticated;
grant execute on function public.list_due_subscription_renewals(uuid, integer) to service_role;

create or replace function public.create_subscription_renewal_charge(p_subscription_id uuid)
returns public.charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub      public.client_subscriptions%rowtype;
  v_plan     public.billing_plans%rowtype;
  v_period   date;
  v_row      public.charges%rowtype;
begin
  select * into v_sub from public.client_subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Assinatura não encontrada';
  end if;

  if v_sub.status <> 'active' or v_sub.next_billing_at is null or v_sub.next_billing_at > now() then
    raise exception 'Assinatura não está com renovação vencida no momento';
  end if;

  select * into v_plan from public.billing_plans where id = v_sub.plan_id;
  if not found or v_plan.billing_type <> 'recurring_monthly' then
    raise exception 'Plano inválido para renovação mensal';
  end if;

  v_period := date_trunc('month', v_sub.next_billing_at)::date;

  insert into public.charges (
    company_id, client_id, description, amount, due_date, status,
    payment_methods, max_installments, plan_id, subscription_id, renewal_period
  ) values (
    v_sub.company_id, v_sub.client_id,
    'Renovação — Plano ' || v_plan.name,
    v_plan.amount, v_sub.next_billing_at::date, 'pending',
    v_plan.payment_methods, v_plan.max_installments, v_plan.id, v_sub.id, v_period
  )
  on conflict (subscription_id, renewal_period) where subscription_id is not null and renewal_period is not null
  do nothing
  returning * into v_row;

  -- Ciclo já tinha cobrança (corrida com outra execução do worker): devolve
  -- a existente em vez de erro — mesmo padrão de idempotência já usado em
  -- enqueue_daily_reminder_system.
  if v_row.id is null then
    select * into v_row from public.charges where subscription_id = v_sub.id and renewal_period = v_period;
  end if;

  return v_row;
end;
$$;
comment on function public.create_subscription_renewal_charge(uuid) is 'Cria a cobrança do próximo ciclo mensal de uma assinatura vencida. Idempotente por (subscription_id, renewal_period) — nunca cria 2 cobranças para o mesmo mês. Uso exclusivo do worker via service_role.';

revoke all on function public.create_subscription_renewal_charge(uuid) from public, anon, authenticated;
grant execute on function public.create_subscription_renewal_charge(uuid) to service_role;

-- Enfileira o aviso de WhatsApp da cobrança de renovação recém-criada.
-- Reaproveita a MESMA fila (whatsapp_outbox) e o MESMO worker/queue.js que
-- já processa tudo — nenhuma integração paralela. message_type = 'charge'
-- (é literalmente uma cobrança nova) — não usa 'due_soon_reminder'/
-- 'overdue_reminder' porque enqueue_whatsapp_message_system() é restrita a
-- esses dois tipos de propósito (ver sql/vps_worker_automation.sql).
create or replace function public.enqueue_renewal_charge_notification_system(
  p_company_id       uuid,
  p_charge_id        uuid,
  p_message          text,
  p_idempotency_key  text
)
returns public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id  uuid;
  v_recipient  text;
  v_row        public.whatsapp_outbox;
begin
  if p_message is null or length(trim(p_message)) = 0 or length(p_message) > 4096 then
    raise exception 'Mensagem inválida';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key é obrigatória para enfileiramento automático';
  end if;

  select c.client_id into v_client_id
  from public.charges c
  where c.id = p_charge_id and c.company_id = p_company_id and c.status = 'pending';

  if v_client_id is null then
    raise exception 'Cobrança de renovação não encontrada, não está mais pendente, ou sem cliente associado';
  end if;

  select whatsapp into v_recipient from public.clients where id = v_client_id and company_id = p_company_id;

  if v_recipient is null or length(trim(v_recipient)) = 0 then
    raise exception 'Cliente não possui WhatsApp cadastrado';
  end if;

  insert into public.whatsapp_outbox (
    company_id, charge_id, client_id, recipient, message, message_type, status, idempotency_key
  ) values (
    p_company_id, p_charge_id, v_client_id, v_recipient, p_message, 'charge', 'pending', p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.whatsapp_outbox where idempotency_key = p_idempotency_key;
  end if;

  return v_row;
end;
$$;
comment on function public.enqueue_renewal_charge_notification_system(uuid, uuid, text, text) is 'Enfileira o aviso de WhatsApp de uma cobrança de renovação mensal recém-criada. Uso exclusivo do worker via service_role.';

revoke all on function public.enqueue_renewal_charge_notification_system(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_renewal_charge_notification_system(uuid, uuid, text, text) to service_role;


-- ============================================================================
-- 13. GESTÃO DE PLANOS/OFERTAS PARA O PAINEL (authenticated)
-- ============================================================================

-- Cria uma oferta validando que TODOS os planos pertencem à empresa do
-- usuário autenticado e estão ativos — nunca aceita plan_ids de outra
-- empresa nem planos desativados.
create or replace function public.create_plan_offer(
  p_company_id  uuid,
  p_client_id   uuid,
  p_plan_ids    uuid[],
  p_title       text default null,
  p_message     text default null,
  p_expires_in_days integer default 7
)
returns public.plan_offers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_valid_count integer;
  v_row         public.plan_offers%rowtype;
begin
  if not public.has_company_role(p_company_id, array['owner', 'admin', 'employee']::public.company_role[]) then
    raise exception 'Sem permissão para criar ofertas nesta empresa';
  end if;

  if p_plan_ids is null or array_length(p_plan_ids, 1) is null then
    raise exception 'Selecione ao menos um plano';
  end if;

  if not exists (select 1 from public.clients where id = p_client_id and company_id = p_company_id) then
    raise exception 'Cliente não encontrado nesta empresa';
  end if;

  select count(*) into v_valid_count
  from public.billing_plans
  where id = any (p_plan_ids) and company_id = p_company_id and active = true;

  if v_valid_count <> array_length(p_plan_ids, 1) then
    raise exception 'Um ou mais planos selecionados não pertencem a esta empresa ou estão inativos';
  end if;

  insert into public.plan_offers (company_id, client_id, plan_ids, title, message, expires_at, created_by)
  values (
    p_company_id, p_client_id, p_plan_ids, p_title, p_message,
    now() + (greatest(coalesce(p_expires_in_days, 7), 1) || ' days')::interval,
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;
comment on function public.create_plan_offer(uuid, uuid, uuid[], text, text, integer) is 'Cria uma oferta de planos para um cliente (uso do painel). Valida que todos os planos pertencem à empresa e estão ativos.';

grant execute on function public.create_plan_offer(uuid, uuid, uuid[], text, text, integer) to authenticated;

-- Cancela uma assinatura (uso do painel — ex.: cliente pediu cancelamento).
-- Nunca apaga histórico; só marca status/cancelled_at.
create or replace function public.cancel_client_subscription(p_subscription_id uuid)
returns public.client_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.client_subscriptions%rowtype;
begin
  select * into v_sub from public.client_subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Assinatura não encontrada';
  end if;

  if not public.has_company_role(v_sub.company_id, array['owner', 'admin']::public.company_role[]) then
    raise exception 'Sem permissão para cancelar assinaturas nesta empresa';
  end if;

  update public.client_subscriptions
  set status = 'cancelled', cancelled_at = now(), next_billing_at = null
  where id = v_sub.id
  returning * into v_sub;

  return v_sub;
end;
$$;
comment on function public.cancel_client_subscription(uuid) is 'Cancela uma assinatura (uso do painel, owner/admin). Preserva todo o histórico de cobranças já geradas.';

grant execute on function public.cancel_client_subscription(uuid) to authenticated;

-- Fim da migração.
