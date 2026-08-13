-- ============================================================================
-- Smart Billing — Agente local de WhatsApp (QR Code)
-- ----------------------------------------------------------------------------
-- Script idempotente (create if not exists / create or replace / drop+create
-- policy) — pode ser executado múltiplas vezes sem apagar dados existentes.
--
-- PRÉ-REQUISITO: rode sql/supabase_schema.sql primeiro. Este arquivo depende
-- de objetos já criados por ele: public.companies, public.charges,
-- public.receipts, public.clients, public.profiles, public.company_role,
-- public.is_company_member(), public.has_company_role(),
-- public.set_updated_at().
--
-- Arquitetura:
--   - O agente local (Node.js, whatsapp-web.js) NUNCA acessa este banco com
--     a anon key. Ele fala apenas com a Edge Function whatsapp-agent-api,
--     autenticada por um token compartilhado (x-agent-token), que usa a
--     service_role internamente.
--   - O painel (usuário autenticado) insere mensagens na fila através da
--     função enqueue_whatsapp_message() — nunca com INSERT direto — para que
--     o destinatário (telefone) seja sempre lido do cadastro do cliente no
--     banco, nunca aceito "cru" do navegador.
--   - claim_whatsapp_jobs() usa FOR UPDATE SKIP LOCKED para permitir que a
--     fila seja processada de forma atômica, sem duas execuções pegarem a
--     mesma mensagem.
-- ============================================================================

-- ============================================================================
-- 1. TIPOS (ENUMS)
-- ============================================================================
do $$ begin
  create type public.whatsapp_agent_status as enum (
    'offline', 'starting', 'qr_required', 'authenticated', 'ready', 'disconnected', 'error'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.whatsapp_job_status as enum (
    'pending', 'processing', 'sent', 'failed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.whatsapp_message_type as enum (
    'charge', 'overdue_reminder', 'due_soon_reminder', 'receipt', 'test', 'custom'
  );
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2. TABELAS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- whatsapp_agent_state: estado atual (1 linha por empresa) do agente local.
-- Escrito exclusivamente pela Edge Function whatsapp-agent-api (service_role).
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_agent_state (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null unique references public.companies (id) on delete cascade,
  status            public.whatsapp_agent_status not null default 'offline',
  phone_number      text,
  display_name      text,
  qr_code           text,
  last_seen_at      timestamptz,
  connected_at      timestamptz,
  disconnected_at   timestamptz,
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.whatsapp_agent_state is 'Estado atual (1 linha por empresa) do agente local de WhatsApp. Só a Edge Function whatsapp-agent-api (service_role) escreve aqui.';

-- ---------------------------------------------------------------------------
-- whatsapp_outbox: fila de mensagens a enviar pelo agente local.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_outbox (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete cascade,
  charge_id           uuid references public.charges (id) on delete set null,
  receipt_id          uuid references public.receipts (id) on delete set null,
  client_id           uuid references public.clients (id) on delete set null,
  recipient           text not null,
  message             text not null check (char_length(message) between 1 and 4096),
  message_type        public.whatsapp_message_type not null default 'custom',
  status              public.whatsapp_job_status not null default 'pending',
  attempts            integer not null default 0,
  max_attempts        integer not null default 3,
  idempotency_key      text unique,
  whatsapp_message_id  text,
  scheduled_at        timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  failed_at           timestamptz,
  error_message       text,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.whatsapp_outbox is 'Fila de mensagens de WhatsApp a enviar pelo agente local. Preenchida via enqueue_whatsapp_message(), processada via claim_whatsapp_jobs().';

-- ---------------------------------------------------------------------------
-- whatsapp_settings: preferências de envio automático por empresa.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_settings (
  company_id                uuid primary key references public.companies (id) on delete cascade,
  send_charge_on_create     boolean not null default false,
  send_receipt_on_payment   boolean not null default false,
  remind_3_days_before      boolean not null default false,
  remind_1_day_before       boolean not null default false,
  remind_on_due_date        boolean not null default false,
  remind_when_overdue       boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table public.whatsapp_settings is 'Preferências de envio automático de WhatsApp por empresa. Os lembretes por data exigem um agendador (não incluído nesta versão) para disparar sozinhos.';


-- ============================================================================
-- 3. ÍNDICES
-- ============================================================================
create index if not exists idx_whatsapp_outbox_company        on public.whatsapp_outbox (company_id);
create index if not exists idx_whatsapp_outbox_status          on public.whatsapp_outbox (status);
create index if not exists idx_whatsapp_outbox_scheduled_at     on public.whatsapp_outbox (scheduled_at);
-- A própria coluna já tem "unique" (idempotency_key text unique, acima) — em
-- Postgres isso permite múltiplos NULLs e rejeita apenas valores repetidos
-- não nulos, então nenhum índice parcial adicional é necessário aqui. O
-- ON CONFLICT (idempotency_key) em enqueue_whatsapp_message() usa esse
-- índice único da coluna diretamente.
create index if not exists idx_whatsapp_outbox_charge           on public.whatsapp_outbox (charge_id);
create index if not exists idx_whatsapp_outbox_receipt          on public.whatsapp_outbox (receipt_id);
-- Acelera a busca atômica em claim_whatsapp_jobs (status pending + scheduled_at).
create index if not exists idx_whatsapp_outbox_claim            on public.whatsapp_outbox (company_id, status, scheduled_at) where status = 'pending';


-- ============================================================================
-- 4. TRIGGERS updated_at (reaproveita public.set_updated_at() já criada em
--    sql/supabase_schema.sql)
-- ============================================================================
drop trigger if exists trg_whatsapp_agent_state_updated_at on public.whatsapp_agent_state;
create trigger trg_whatsapp_agent_state_updated_at before update on public.whatsapp_agent_state
  for each row execute function public.set_updated_at();

drop trigger if exists trg_whatsapp_outbox_updated_at on public.whatsapp_outbox;
create trigger trg_whatsapp_outbox_updated_at before update on public.whatsapp_outbox
  for each row execute function public.set_updated_at();

drop trigger if exists trg_whatsapp_settings_updated_at on public.whatsapp_settings;
create trigger trg_whatsapp_settings_updated_at before update on public.whatsapp_settings
  for each row execute function public.set_updated_at();


-- ============================================================================
-- 5. claim_whatsapp_jobs — reivindicação atômica de mensagens pendentes
-- ----------------------------------------------------------------------------
-- Usa FOR UPDATE SKIP LOCKED para que, mesmo com chamadas concorrentes, cada
-- mensagem seja entregue a apenas uma execução. Restrita à service_role: só
-- a Edge Function whatsapp-agent-api (nunca o navegador) pode chamá-la.
--
-- Antes de reivindicar, faz duas higienizações (necessárias para o worker
-- de cobrança automática — ver sql/vps_worker_automation.sql para o
-- histórico/justificativa completa):
--   (a) cancela mensagens "pending" de tipo charge/due_soon_reminder/
--       overdue_reminder cuja cobrança não está mais pendente (paga/
--       cancelada) ou foi excluída (charge_id NULL);
--   (b) marca como "failed" mensagens travadas em "processing" há mais de
--       5 minutos (worker encerrado/travado no meio do envio) — nunca
--       volta sozinha para "pending", para não arriscar duplicar uma
--       mensagem que pode já ter sido entregue antes do crash.
-- ============================================================================
create or replace function public.claim_whatsapp_jobs(p_company_id uuid, p_limit integer default 5)
returns setof public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.whatsapp_outbox o
  set status = 'cancelled',
      error_message = 'Cobrança não está mais pendente (paga/cancelada/excluída) no momento do envio — lembrete cancelado automaticamente.',
      updated_at = now()
  where o.company_id = p_company_id
    and o.status = 'pending'
    and o.message_type in ('charge', 'due_soon_reminder', 'overdue_reminder')
    and not exists (
      select 1 from public.charges c
      where c.id = o.charge_id and c.status = 'pending'
    );

  update public.whatsapp_outbox o
  set status = 'failed',
      failed_at = now(),
      error_message = 'Reivindicado mas não confirmado dentro do tempo esperado (processo pode ter sido interrompido). Verifique manualmente se a mensagem já foi entregue antes de reenviar.',
      updated_at = now()
  where o.company_id = p_company_id
    and o.status = 'processing'
    and o.claimed_at < now() - interval '5 minutes';

  return query
  update public.whatsapp_outbox
  set status = 'processing',
      attempts = attempts + 1,
      claimed_at = now(),
      updated_at = now()
  where id in (
    select o.id
    from public.whatsapp_outbox o
    where o.company_id = p_company_id
      and o.status = 'pending'
      and o.scheduled_at <= now()
    order by o.scheduled_at asc
    limit greatest(coalesce(p_limit, 5), 0)
    for update skip locked
  )
  returning *;
end;
$$;
comment on function public.claim_whatsapp_jobs(uuid, integer) is 'Reivindica atomicamente até p_limit mensagens pendentes de uma empresa (FOR UPDATE SKIP LOCKED). Antes disso, cancela lembretes cuja cobrança não está mais pendente/existe, e falha mensagens travadas em processing há mais de 5min. Uso exclusivo da service_role (Edge Function whatsapp-agent-api).';

revoke all on function public.claim_whatsapp_jobs(uuid, integer) from public;
revoke all on function public.claim_whatsapp_jobs(uuid, integer) from anon, authenticated;
grant execute on function public.claim_whatsapp_jobs(uuid, integer) to service_role;


-- ============================================================================
-- 6. enqueue_whatsapp_message — único caminho para o painel enfileirar uma
--    mensagem
-- ----------------------------------------------------------------------------
-- O destinatário NUNCA é aceito do navegador: é sempre lido do cadastro do
-- cliente (clients.whatsapp) a partir de charge_id/receipt_id/client_id, e
-- validado contra a empresa do usuário autenticado. Isso impede que a tela
-- (mesmo comprometida) dispare mensagens para números arbitrários.
-- ============================================================================
create or replace function public.enqueue_whatsapp_message(
  p_company_id       uuid,
  p_message_type     public.whatsapp_message_type,
  p_message          text,
  p_charge_id        uuid default null,
  p_receipt_id       uuid default null,
  p_client_id        uuid default null,
  p_idempotency_key  text default null
)
returns public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient  text;
  v_client_id  uuid := p_client_id;
  v_row        public.whatsapp_outbox;
begin
  if not public.has_company_role(p_company_id, array['owner', 'admin', 'employee']::public.company_role[]) then
    raise exception 'Sem permissão para enviar mensagens nesta empresa';
  end if;

  if p_message is null or length(trim(p_message)) = 0 or length(p_message) > 4096 then
    raise exception 'Mensagem inválida';
  end if;

  if p_message_type = 'test' then
    -- Mensagem de teste: sempre para o WhatsApp do próprio usuário autenticado
    -- (nunca um destinatário informado pelo navegador).
    select phone into v_recipient from public.profiles where id = auth.uid();
    if v_recipient is null or length(trim(v_recipient)) = 0 then
      raise exception 'Cadastre seu WhatsApp em Configurações → Perfil antes de enviar uma mensagem de teste';
    end if;
  else
    if v_client_id is null and p_charge_id is not null then
      select client_id into v_client_id from public.charges where id = p_charge_id and company_id = p_company_id;
    end if;
    if v_client_id is null and p_receipt_id is not null then
      select c.client_id into v_client_id
      from public.receipts r
      join public.charges c on c.id = r.charge_id
      where r.id = p_receipt_id and r.company_id = p_company_id;
    end if;
    if v_client_id is not null then
      select whatsapp into v_recipient from public.clients where id = v_client_id and company_id = p_company_id;
    end if;
  end if;

  if v_recipient is null or length(trim(v_recipient)) = 0 then
    raise exception 'Cliente não possui WhatsApp cadastrado';
  end if;

  insert into public.whatsapp_outbox (
    company_id, charge_id, receipt_id, client_id, recipient, message, message_type,
    status, idempotency_key, created_by
  ) values (
    p_company_id,
    case when p_message_type = 'test' then null else p_charge_id end,
    case when p_message_type = 'test' then null else p_receipt_id end,
    case when p_message_type = 'test' then null else v_client_id end,
    v_recipient, p_message, p_message_type,
    'pending', p_idempotency_key, auth.uid()
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  -- idempotency_key já existia: devolve a mensagem original em vez de erro,
  -- para que um clique duplicado nunca crie duas linhas na fila.
  if v_row.id is null and p_idempotency_key is not null then
    select * into v_row from public.whatsapp_outbox where idempotency_key = p_idempotency_key;
  end if;

  return v_row;
end;
$$;
comment on function public.enqueue_whatsapp_message(uuid, public.whatsapp_message_type, text, uuid, uuid, uuid, text) is 'Único caminho para o painel enfileirar uma mensagem de WhatsApp. Resolve o destinatário sempre a partir do banco, nunca do navegador.';

grant execute on function public.enqueue_whatsapp_message(uuid, public.whatsapp_message_type, text, uuid, uuid, uuid, text) to authenticated;


-- ============================================================================
-- 7. RLS
-- ============================================================================

-- ---------------- whatsapp_agent_state ----------------
alter table public.whatsapp_agent_state enable row level security;

drop policy if exists whatsapp_agent_state_select_members on public.whatsapp_agent_state;
create policy whatsapp_agent_state_select_members on public.whatsapp_agent_state
  for select using (public.is_company_member(public.whatsapp_agent_state.company_id));

-- Nenhuma policy de insert/update/delete: só a service_role (Edge Function
-- whatsapp-agent-api) escreve nesta tabela — RLS não afeta a service_role.

-- ---------------- whatsapp_outbox ----------------
alter table public.whatsapp_outbox enable row level security;

drop policy if exists whatsapp_outbox_select_members on public.whatsapp_outbox;
create policy whatsapp_outbox_select_members on public.whatsapp_outbox
  for select using (public.is_company_member(public.whatsapp_outbox.company_id));

-- Nenhuma policy de insert/update/delete para authenticated: todo INSERT
-- passa por enqueue_whatsapp_message() (security definer) e todo UPDATE de
-- status é feito pela service_role via claim_whatsapp_jobs()/Edge Function.

-- ---------------- whatsapp_settings ----------------
alter table public.whatsapp_settings enable row level security;

drop policy if exists whatsapp_settings_select_members on public.whatsapp_settings;
create policy whatsapp_settings_select_members on public.whatsapp_settings
  for select using (public.is_company_member(public.whatsapp_settings.company_id));

drop policy if exists whatsapp_settings_upsert_managers on public.whatsapp_settings;
create policy whatsapp_settings_upsert_managers on public.whatsapp_settings
  for insert with check (public.has_company_role(public.whatsapp_settings.company_id, array['owner', 'admin']::public.company_role[]));

drop policy if exists whatsapp_settings_update_managers on public.whatsapp_settings;
create policy whatsapp_settings_update_managers on public.whatsapp_settings
  for update using (public.has_company_role(public.whatsapp_settings.company_id, array['owner', 'admin']::public.company_role[]))
  with check (public.has_company_role(public.whatsapp_settings.company_id, array['owner', 'admin']::public.company_role[]));


-- ============================================================================
-- 8. GRANTS de tabela (RLS continua se aplicando por cima destes grants)
-- ============================================================================
grant select on public.whatsapp_agent_state to authenticated;
grant select on public.whatsapp_outbox to authenticated;
grant select, insert, update on public.whatsapp_settings to authenticated;

revoke all on public.whatsapp_agent_state from anon;
revoke all on public.whatsapp_outbox from anon;
revoke all on public.whatsapp_settings from anon;
