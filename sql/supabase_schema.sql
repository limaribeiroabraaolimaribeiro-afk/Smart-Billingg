-- ============================================================================
-- Smart Billing — Schema completo do Supabase (PostgreSQL)
-- ----------------------------------------------------------------------------
-- Este arquivo é 100% idempotente: pode ser executado várias vezes no SQL
-- Editor do Supabase sem gerar erro de "já existe". Rode o arquivo inteiro de
-- uma vez (Run), não é necessário executar em partes.
--
-- Ordem do arquivo:
--   1. Extensões
--   2. Tipos enumerados (enums)
--   3. Tabelas
--   4. Índices
--   5. Função e triggers de updated_at
--   6. Geração automática de charge_number (COB-000001...)
--   7. Funções auxiliares de autorização (is_company_member / has_company_role)
--   8. Cadastro automático (profile + empresa + membro owner) ao criar usuário
--   9. Funções públicas seguras (acesso via public_token, sem login)
--  10. Função de reconciliação manual de pagamento (marcar como pago)
--  11. Views de dashboard/relatórios (security_invoker, respeitam RLS)
--  12. RLS: habilitação + políticas de cada tabela
--  13. Grants finais (reforço de bloqueio de webhook_events etc.)
-- ============================================================================


-- ============================================================================
-- 1. EXTENSÕES
-- ============================================================================
create extension if not exists "pgcrypto";


-- ============================================================================
-- 2. TIPOS ENUMERADOS
-- ============================================================================
do $$ begin
  create type public.company_role as enum ('owner', 'admin', 'employee', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.client_status as enum ('active', 'inactive');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.charge_status as enum ('pending', 'paid', 'overdue', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum ('pending', 'approved', 'failed', 'refunded', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_channel as enum ('whatsapp', 'email', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method_type as enum ('pix', 'cartao');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 3. TABELAS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: um registro por usuário do Supabase Auth (auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null default 'Administrador',
  email       text,
  phone       text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'Dados de perfil de cada usuário autenticado (1:1 com auth.users).';

-- ---------------------------------------------------------------------------
-- companies: empresa/conta que emite cobranças. Cada usuário recebe uma
-- empresa inicial automaticamente no cadastro.
-- ---------------------------------------------------------------------------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  name        text not null default 'Minha Empresa',
  legal_name  text,
  document    text,
  email       text,
  phone       text,
  whatsapp    text,
  logo_url    text,
  address     text,
  city        text,
  state       text,
  zip_code    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.companies is 'Empresa/conta emissora de cobranças. owner_id é o criador original.';

-- ---------------------------------------------------------------------------
-- company_members: relação usuário <-> empresa com papel (role). Prepara o
-- sistema para múltiplos usuários por empresa no futuro.
-- ---------------------------------------------------------------------------
create table if not exists public.company_members (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.company_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  unique (company_id, user_id)
);
comment on table public.company_members is 'Membros de uma empresa e seu papel (owner/admin/employee/viewer).';

-- ---------------------------------------------------------------------------
-- clients: clientes cadastrados por uma empresa
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  name        text not null,
  email       text,
  whatsapp    text,
  document    text,
  notes       text,
  status      public.client_status not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.clients is 'Clientes de uma empresa, usados para emitir cobranças.';

-- ---------------------------------------------------------------------------
-- charges: cobranças emitidas
-- ---------------------------------------------------------------------------
create table if not exists public.charges (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete cascade,
  client_id           uuid references public.clients (id) on delete set null,
  charge_number       text unique,
  description         text not null,
  amount              numeric(12, 2) not null check (amount > 0),
  due_date            date not null,
  status              public.charge_status not null default 'pending',
  payment_methods     jsonb not null default '["pix"]'::jsonb
                        check (payment_methods <@ '["pix", "cartao"]'::jsonb),
  max_installments    integer not null default 1 check (max_installments between 1 and 24),
  notes               text,
  public_token        uuid not null default gen_random_uuid() unique,
  checkout_url        text,
  provider             text not null default 'infinitepay',
  provider_reference  text,
  paid_at             timestamptz,
  cancelled_at        timestamptz,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.charges is 'Cobranças emitidas para clientes. public_token permite acesso público sem login.';

-- ---------------------------------------------------------------------------
-- payments: pagamentos recebidos (via gateway ou reconciliação manual)
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies (id) on delete cascade,
  charge_id                 uuid not null references public.charges (id) on delete cascade,
  provider                  text not null default 'infinitepay',
  provider_transaction_id   text,
  payment_method            public.payment_method_type not null,
  installments              integer not null default 1 check (installments between 1 and 24),
  gross_amount              numeric(12, 2) not null check (gross_amount >= 0),
  fee_amount                numeric(12, 2) not null default 0 check (fee_amount >= 0),
  net_amount                numeric(12, 2) not null check (net_amount >= 0),
  status                    public.payment_status not null default 'pending',
  paid_at                   timestamptz,
  receipt_url               text,
  raw_payload               jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table public.payments is 'Pagamentos associados a uma cobrança. Pode vir de webhook do gateway ou reconciliação manual.';

-- ---------------------------------------------------------------------------
-- receipts: recibos emitidos para pagamentos confirmados
-- ---------------------------------------------------------------------------
create table if not exists public.receipts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  charge_id       uuid not null references public.charges (id) on delete cascade,
  payment_id      uuid not null references public.payments (id) on delete cascade,
  receipt_number  text unique,
  public_token    uuid not null default gen_random_uuid() unique,
  pdf_url         text,
  issued_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.receipts is 'Recibo gerado para um pagamento confirmado. public_token permite consulta pública.';

-- ---------------------------------------------------------------------------
-- webhook_events: log bruto de eventos recebidos de gateways de pagamento.
-- NUNCA deve ser acessível pelo frontend (nem anon, nem authenticated) —
-- somente a service_role (usada pelas Edge Functions) pode gravar/ler.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  event_id        text not null,
  event_type      text,
  payload         jsonb,
  processed       boolean not null default false,
  processed_at    timestamptz,
  error_message   text,
  created_at      timestamptz not null default now(),
  unique (provider, event_id) -- evita processar duas vezes o mesmo evento
);
comment on table public.webhook_events is 'Log de eventos recebidos de webhooks (ex.: InfinitePay). Acesso restrito à service_role.';

-- ---------------------------------------------------------------------------
-- notification_logs: histórico de envios (WhatsApp/e-mail/manual)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_logs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  charge_id       uuid references public.charges (id) on delete set null,
  channel         public.notification_channel not null,
  recipient       text,
  status          text not null default 'sent',
  message         text,
  error_message   text,
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
comment on table public.notification_logs is 'Histórico de envios de cobrança/recibo por WhatsApp, e-mail ou ação manual.';


-- ============================================================================
-- 4. ÍNDICES
-- ============================================================================
create index if not exists idx_companies_owner            on public.companies (owner_id);
create index if not exists idx_company_members_company     on public.company_members (company_id);
create index if not exists idx_company_members_user        on public.company_members (user_id);
create index if not exists idx_clients_company             on public.clients (company_id);
create index if not exists idx_clients_status              on public.clients (company_id, status);
create index if not exists idx_charges_company             on public.charges (company_id);
create index if not exists idx_charges_client               on public.charges (client_id);
create index if not exists idx_charges_status              on public.charges (company_id, status);
create index if not exists idx_charges_due_date             on public.charges (company_id, due_date);
create index if not exists idx_charges_public_token         on public.charges (public_token);
create index if not exists idx_payments_company             on public.payments (company_id);
create index if not exists idx_payments_charge              on public.payments (charge_id);
create index if not exists idx_receipts_company             on public.receipts (company_id);
create index if not exists idx_receipts_charge               on public.receipts (charge_id);
create index if not exists idx_receipts_public_token         on public.receipts (public_token);
create index if not exists idx_notification_logs_company     on public.notification_logs (company_id);
create index if not exists idx_notification_logs_charge      on public.notification_logs (charge_id);
create index if not exists idx_webhook_events_provider_event  on public.webhook_events (provider, event_id);


-- ============================================================================
-- 5. FUNÇÃO E TRIGGERS DE updated_at
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
comment on function public.set_updated_at() is 'Atualiza updated_at automaticamente em qualquer UPDATE.';

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_companies_updated_at on public.companies;
create trigger trg_companies_updated_at before update on public.companies
  for each row execute function public.set_updated_at();

drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

drop trigger if exists trg_charges_updated_at on public.charges;
create trigger trg_charges_updated_at before update on public.charges
  for each row execute function public.set_updated_at();

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

drop trigger if exists trg_receipts_updated_at on public.receipts;
create trigger trg_receipts_updated_at before update on public.receipts
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 6. GERAÇÃO AUTOMÁTICA DE charge_number (COB-000001, COB-000002, ...)
-- ============================================================================
create sequence if not exists public.charge_number_seq start 1;

create or replace function public.generate_charge_number()
returns trigger
language plpgsql
as $$
begin
  if new.charge_number is null then
    new.charge_number := 'COB-' || lpad(nextval('public.charge_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;
comment on function public.generate_charge_number() is 'Gera charge_number sequencial no formato COB-000001 quando não informado.';

drop trigger if exists trg_charges_number on public.charges;
create trigger trg_charges_number before insert on public.charges
  for each row execute function public.generate_charge_number();


-- ============================================================================
-- 7. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO
-- ----------------------------------------------------------------------------
-- security invoker (padrão) mas marcadas STABLE para performance em políticas
-- de RLS. Usam search_path fixo para evitar sequestro de schema.
-- ============================================================================
create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
  );
$$;
comment on function public.is_company_member(uuid) is 'Verifica se o usuário autenticado é membro da empresa informada.';

create or replace function public.has_company_role(p_company_id uuid, p_roles public.company_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;
comment on function public.has_company_role(uuid, public.company_role[]) is 'Verifica se o usuário autenticado possui um dos papéis informados na empresa.';

-- Empresa "padrão" do usuário autenticado (a primeira em que ele é owner,
-- ou a primeira em que é membro). Usada pelo frontend para saber em qual
-- company_id gravar novos registros.
create or replace function public.my_default_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.company_id
  from public.company_members m
  where m.user_id = auth.uid()
  order by (m.role = 'owner') desc, m.created_at asc
  limit 1;
$$;
comment on function public.my_default_company_id() is 'Retorna a empresa padrão (preferencialmente onde o usuário é owner) do usuário autenticado.';

grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.has_company_role(uuid, public.company_role[]) to authenticated;
grant execute on function public.my_default_company_id() to authenticated;


-- ============================================================================
-- 8. CADASTRO AUTOMÁTICO: profile + empresa inicial + membro owner
-- ----------------------------------------------------------------------------
-- Disparado após um novo usuário ser criado em auth.users (Supabase Auth).
-- Usa os metadados enviados no signUp (name, company_name, phone) quando
-- disponíveis, caso contrário aplica valores padrão seguros.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name         text;
  v_company_name text;
  v_phone        text;
  v_company_id   uuid;
begin
  v_name         := coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1), 'Administrador');
  v_company_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'company_name'), ''), 'Minha Empresa');
  v_phone        := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');

  insert into public.profiles (id, name, email, phone)
  values (new.id, v_name, new.email, v_phone)
  on conflict (id) do nothing;

  insert into public.companies (owner_id, name, email, whatsapp)
  values (new.id, v_company_name, new.email, v_phone)
  returning id into v_company_id;

  insert into public.company_members (company_id, user_id, role)
  values (v_company_id, new.id, 'owner')
  on conflict (company_id, user_id) do nothing;

  return new;
end;
$$;
comment on function public.handle_new_user() is 'Cria profile + empresa inicial + membership owner ao registrar um novo usuário.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- 9. FUNÇÕES PÚBLICAS SEGURAS (acesso sem login, somente via public_token)
-- ----------------------------------------------------------------------------
-- Estas funções são SECURITY DEFINER e liberadas para o papel "anon" — porém
-- só retornam UMA linha específica (identificada pelo token secreto) e um
-- conjunto restrito de colunas. Nenhum dado sensível da empresa (documento,
-- endereço, etc.) é exposto. Não existe policy pública direta sobre as
-- tabelas charges/receipts — todo acesso público passa por aqui.
-- ============================================================================
create or replace function public.get_public_charge_by_token(p_token uuid)
returns table (
  id                uuid,
  charge_number     text,
  description       text,
  amount            numeric,
  due_date          date,
  status            public.charge_status,
  payment_methods   jsonb,
  max_installments  integer,
  checkout_url      text,
  paid_at           timestamptz,
  cancelled_at      timestamptz,
  client_name       text,
  company_name      text
)
language sql
stable
security definer
set search_path = public
as $$
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
    co.name as company_name
  from public.charges c
  left join public.clients cl on cl.id = c.client_id
  join public.companies co on co.id = c.company_id
  where c.public_token = p_token;
$$;
comment on function public.get_public_charge_by_token(uuid) is 'Retorna dados públicos e seguros de UMA cobrança via public_token, sem exigir login.';

create or replace function public.get_public_receipt_by_token(p_token uuid)
returns table (
  id                uuid,
  receipt_number    text,
  issued_at         timestamptz,
  charge_number     text,
  description       text,
  client_name       text,
  company_name      text,
  payment_method    public.payment_method_type,
  installments      integer,
  gross_amount      numeric,
  paid_at           timestamptz,
  provider_transaction_id text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    r.receipt_number,
    r.issued_at,
    c.charge_number,
    c.description,
    cl.name as client_name,
    co.name as company_name,
    p.payment_method,
    p.installments,
    p.gross_amount,
    p.paid_at,
    p.provider_transaction_id
  from public.receipts r
  join public.charges c on c.id = r.charge_id
  join public.payments p on p.id = r.payment_id
  join public.companies co on co.id = r.company_id
  left join public.clients cl on cl.id = c.client_id
  where r.public_token = p_token;
$$;
comment on function public.get_public_receipt_by_token(uuid) is 'Retorna dados públicos e seguros de UM recibo via public_token, sem exigir login.';

grant execute on function public.get_public_charge_by_token(uuid) to anon, authenticated;
grant execute on function public.get_public_receipt_by_token(uuid) to anon, authenticated;


-- ============================================================================
-- 10. RECONCILIAÇÃO MANUAL DE PAGAMENTO ("Marcar como pago")
-- ----------------------------------------------------------------------------
-- Usada pelo painel interno (owner/admin/employee) para registrar o
-- recebimento manual de uma cobrança (ex.: dinheiro, Pix fora do gateway).
-- Cria o pagamento, o recibo e atualiza a cobrança de forma atômica.
-- Não deve ser usada para simular aprovação de pagamento na página pública.
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

  return query select v_charge.id, v_payment_id, v_receipt_id;
end;
$$;
comment on function public.register_manual_payment(uuid, public.payment_method_type, integer) is
  'Registra reconciliação manual de pagamento (uso interno do painel), gerando payment + receipt e atualizando a cobrança.';

grant execute on function public.register_manual_payment(uuid, public.payment_method_type, integer) to authenticated;


-- ============================================================================
-- 11. VIEWS DE DASHBOARD / RELATÓRIOS
-- ----------------------------------------------------------------------------
-- Todas criadas com security_invoker = true: a política de RLS aplicada é a
-- do usuário que está consultando a view (não a do dono da view). Isso
-- garante que cada usuário só enxergue as linhas das empresas de que
-- participa, exatamente como se consultasse as tabelas base diretamente.
-- O frontend (data.js), por segurança, NÃO depende exclusivamente destas
-- views: os totais também podem ser recalculados a partir de charges/
-- payments filtrando por company_id sempre que necessário.
-- ============================================================================

create or replace view public.v_charge_status_breakdown
with (security_invoker = true) as
select
  company_id,
  case
    when status = 'pending' and due_date < current_date then 'overdue'
    else status::text
  end as effective_status,
  count(*) as qty,
  coalesce(sum(amount), 0) as total_amount
from public.charges
group by company_id, 2;
comment on view public.v_charge_status_breakdown is 'Quantidade e valor de cobranças agrupadas por status efetivo (considera atraso).';

create or replace view public.v_monthly_revenue
with (security_invoker = true) as
select
  p.company_id,
  date_trunc('month', p.paid_at)::date as month,
  sum(p.net_amount) as total_net,
  sum(p.gross_amount) as total_gross,
  count(*) as qty
from public.payments p
where p.status = 'approved'
group by p.company_id, 2;
comment on view public.v_monthly_revenue is 'Faturamento mensal (bruto/líquido) a partir de pagamentos aprovados.';

create or replace view public.v_top_clients
with (security_invoker = true) as
select
  c.company_id,
  c.client_id,
  cl.name as client_name,
  count(*) filter (where c.status = 'paid') as charges_paid,
  coalesce(sum(c.amount) filter (where c.status = 'paid'), 0) as total_received,
  coalesce(sum(c.amount) filter (where c.status in ('pending', 'overdue')
      or (c.status = 'pending' and c.due_date < current_date)), 0) as total_pending
from public.charges c
join public.clients cl on cl.id = c.client_id
group by c.company_id, c.client_id, cl.name;
comment on view public.v_top_clients is 'Totais recebidos/pendentes por cliente, para ranking no relatório.';

create or replace view public.v_active_clients_count
with (security_invoker = true) as
select company_id, count(*) as active_clients
from public.clients
where status = 'active'
group by company_id;
comment on view public.v_active_clients_count is 'Quantidade de clientes ativos por empresa.';

create or replace view public.v_dashboard_summary
with (security_invoker = true) as
select
  co.id as company_id,
  coalesce(sum(c.amount) filter (
    where c.status = 'paid' and date_trunc('month', c.paid_at) = date_trunc('month', now())
  ), 0) as total_received_month,
  count(*) filter (
    where c.status = 'paid' and date_trunc('month', c.paid_at) = date_trunc('month', now())
  ) as qty_received_month,
  coalesce(sum(c.amount) filter (where c.status = 'pending' and c.due_date >= current_date), 0) as total_pending,
  count(*) filter (where c.status = 'pending' and c.due_date >= current_date) as qty_pending,
  coalesce(sum(c.amount) filter (where c.status = 'pending' and c.due_date < current_date), 0) as total_overdue,
  count(*) filter (where c.status = 'pending' and c.due_date < current_date) as qty_overdue,
  coalesce(sum(c.amount) filter (where c.status = 'paid' and c.paid_at::date = current_date), 0) as total_paid_today,
  count(*) filter (where c.status = 'paid' and c.paid_at::date = current_date) as qty_paid_today,
  coalesce(sum(c.amount) filter (
    where c.status = 'pending' and c.due_date between current_date and current_date + interval '7 days'
  ), 0) as total_due_soon,
  count(*) filter (
    where c.status = 'pending' and c.due_date between current_date and current_date + interval '7 days'
  ) as qty_due_soon
from public.companies co
left join public.charges c on c.company_id = co.id
group by co.id;
comment on view public.v_dashboard_summary is 'Indicadores agregados do dashboard por empresa (recebido, pendente, atrasado, vencendo, pago hoje).';

grant select on public.v_charge_status_breakdown to authenticated;
grant select on public.v_monthly_revenue to authenticated;
grant select on public.v_top_clients to authenticated;
grant select on public.v_active_clients_count to authenticated;
grant select on public.v_dashboard_summary to authenticated;


-- ============================================================================
-- 12. ROW LEVEL SECURITY (RLS)
-- ----------------------------------------------------------------------------
-- Regra geral: nenhuma policy usa "true" solto. Todo acesso é condicionado a
-- is_company_member / has_company_role, ou à própria identidade (auth.uid()).
-- ============================================================================

-- ---------------- profiles ----------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert with check (id = auth.uid());

-- ---------------- companies ----------------
alter table public.companies enable row level security;

drop policy if exists companies_select_members on public.companies;
create policy companies_select_members on public.companies
  for select using (public.is_company_member(id));

drop policy if exists companies_insert_owner on public.companies;
create policy companies_insert_owner on public.companies
  for insert with check (owner_id = auth.uid());

drop policy if exists companies_update_admins on public.companies;
create policy companies_update_admins on public.companies
  for update using (public.has_company_role(id, array['owner', 'admin']::public.company_role[]))
  with check (public.has_company_role(id, array['owner', 'admin']::public.company_role[]));

drop policy if exists companies_delete_owner on public.companies;
create policy companies_delete_owner on public.companies
  for delete using (public.has_company_role(id, array['owner']::public.company_role[]));

-- ---------------- company_members ----------------
alter table public.company_members enable row level security;

drop policy if exists company_members_select_members on public.company_members;
create policy company_members_select_members on public.company_members
  for select using (public.is_company_member(company_id));

drop policy if exists company_members_insert_owner on public.company_members;
create policy company_members_insert_owner on public.company_members
  for insert with check (public.has_company_role(company_id, array['owner']::public.company_role[]));

drop policy if exists company_members_update_owner on public.company_members;
create policy company_members_update_owner on public.company_members
  for update using (public.has_company_role(company_id, array['owner']::public.company_role[]))
  with check (public.has_company_role(company_id, array['owner']::public.company_role[]));

drop policy if exists company_members_delete_owner on public.company_members;
create policy company_members_delete_owner on public.company_members
  for delete using (public.has_company_role(company_id, array['owner']::public.company_role[]));

-- ---------------- clients ----------------
alter table public.clients enable row level security;

drop policy if exists clients_select_members on public.clients;
create policy clients_select_members on public.clients
  for select using (public.is_company_member(company_id));

drop policy if exists clients_insert_managers on public.clients;
create policy clients_insert_managers on public.clients
  for insert with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists clients_update_managers on public.clients;
create policy clients_update_managers on public.clients
  for update using (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]))
  with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists clients_delete_managers on public.clients;
create policy clients_delete_managers on public.clients
  for delete using (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

-- ---------------- charges ----------------
alter table public.charges enable row level security;

drop policy if exists charges_select_members on public.charges;
create policy charges_select_members on public.charges
  for select using (public.is_company_member(company_id));

drop policy if exists charges_insert_managers on public.charges;
create policy charges_insert_managers on public.charges
  for insert with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists charges_update_managers on public.charges;
create policy charges_update_managers on public.charges
  for update using (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]))
  with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists charges_delete_managers on public.charges;
create policy charges_delete_managers on public.charges
  for delete using (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

-- Não existe policy pública de SELECT em charges: o acesso da página pública
-- é feito exclusivamente via get_public_charge_by_token (security definer).

-- ---------------- payments ----------------
alter table public.payments enable row level security;

drop policy if exists payments_select_members on public.payments;
create policy payments_select_members on public.payments
  for select using (public.is_company_member(company_id));

drop policy if exists payments_insert_managers on public.payments;
create policy payments_insert_managers on public.payments
  for insert with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

drop policy if exists payments_update_managers on public.payments;
create policy payments_update_managers on public.payments
  for update using (public.has_company_role(company_id, array['owner', 'admin']::public.company_role[]))
  with check (public.has_company_role(company_id, array['owner', 'admin']::public.company_role[]));

-- Sem policy de DELETE: registros financeiros são imutáveis via frontend.

-- ---------------- receipts ----------------
alter table public.receipts enable row level security;

drop policy if exists receipts_select_members on public.receipts;
create policy receipts_select_members on public.receipts
  for select using (public.is_company_member(company_id));

drop policy if exists receipts_insert_managers on public.receipts;
create policy receipts_insert_managers on public.receipts
  for insert with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

-- Sem policy de UPDATE/DELETE: recibos são imutáveis via frontend.
-- Acesso público de um recibo específico é via get_public_receipt_by_token.

-- ---------------- notification_logs ----------------
alter table public.notification_logs enable row level security;

drop policy if exists notification_logs_select_members on public.notification_logs;
create policy notification_logs_select_members on public.notification_logs
  for select using (public.is_company_member(company_id));

drop policy if exists notification_logs_insert_managers on public.notification_logs;
create policy notification_logs_insert_managers on public.notification_logs
  for insert with check (public.has_company_role(company_id, array['owner', 'admin', 'employee']::public.company_role[]));

-- ---------------- webhook_events ----------------
-- RLS habilitado e SEM NENHUMA policy: nem anon, nem authenticated conseguem
-- ler ou escrever. Somente a service_role (usada pelas Edge Functions no
-- backend, nunca no navegador) contorna RLS e acessa esta tabela.
alter table public.webhook_events enable row level security;


-- ============================================================================
-- 13. GRANTS FINAIS (reforço explícito de bloqueio)
-- ============================================================================
revoke all on public.webhook_events from anon, authenticated;
revoke all on public.company_members from anon;
revoke all on public.charges from anon;
revoke all on public.payments from anon;
revoke all on public.receipts from anon;

-- Fim do schema. Para dados de teste, use sql/seed_demo.sql separadamente.
