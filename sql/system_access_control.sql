-- Smart Billing: controle de acesso. PostgreSQL 15+ / Supabase.
-- Execute após supabase_schema.sql e billing_plans.sql. Idempotente e atômica.
-- Nenhum valor, pagamento ou status financeiro é alterado por esta migração.
begin;

create unique index if not exists clients_access_identity on public.clients(id, company_id);
create unique index if not exists subscriptions_access_identity
  on public.client_subscriptions(id, client_id, company_id);

create table if not exists public.client_systems (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null,
  subscription_id uuid,
  name text not null check (length(trim(name)) between 1 and 160),
  system_key uuid not null unique default gen_random_uuid(),
  domain text check (length(domain) <= 253),
  auto_block_enabled boolean not null default true,
  grace_days integer not null default 3 check (grace_days between 0 and 365),
  manual_override text not null default 'none'
    check (manual_override in ('none', 'force_active', 'force_suspended')),
  active boolean not null default true,
  last_status text check (last_status in ('active', 'grace', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint systems_client_fk foreign key (client_id, company_id) references public.clients(id, company_id) on delete cascade,
  constraint systems_subscription_fk foreign key (subscription_id, client_id, company_id)
    references public.client_subscriptions(id, client_id, company_id)
    on delete set null (subscription_id)
);
create index if not exists client_systems_company on public.client_systems(company_id);
create index if not exists client_systems_client on public.client_systems(client_id);
create index if not exists client_systems_subscription on public.client_systems(subscription_id);
create index if not exists charges_access_due on public.charges(subscription_id, due_date)
  where status not in ('paid', 'cancelled');

create table if not exists public.system_access_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  system_id uuid not null references public.client_systems(id) on delete cascade,
  previous_status text check (previous_status in ('active', 'grace', 'suspended')),
  new_status text not null check (new_status in ('active', 'grace', 'suspended')),
  reason text not null,
  source text not null check (source in ('administration', 'access_check')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists system_access_logs_company on public.system_access_logs(company_id);
create index if not exists system_access_logs_system on public.system_access_logs(system_id, created_at desc);

alter table public.client_systems enable row level security;
alter table public.system_access_logs enable row level security;
revoke all on public.client_systems, public.system_access_logs from public, anon, authenticated;
grant select on public.client_systems, public.system_access_logs to authenticated;
-- Chave, identidade, timestamps e snapshot não podem ser forjados pelo painel.
grant insert (company_id, client_id, subscription_id, name, domain, auto_block_enabled,
  grace_days, manual_override, active) on public.client_systems to authenticated;
grant update (subscription_id, name, domain, auto_block_enabled, grace_days,
  manual_override, active) on public.client_systems to authenticated;
grant all on public.client_systems, public.system_access_logs to service_role;

drop policy if exists systems_read on public.client_systems;
create policy systems_read on public.client_systems for select to authenticated
  using (public.is_company_member(company_id));
drop policy if exists systems_create on public.client_systems;
create policy systems_create on public.client_systems for insert to authenticated
  with check (public.has_company_role(company_id, array['owner','admin','employee']::public.company_role[]));
drop policy if exists systems_edit on public.client_systems;
create policy systems_edit on public.client_systems for update to authenticated
  using (public.has_company_role(company_id, array['owner','admin','employee']::public.company_role[]))
  with check (public.has_company_role(company_id, array['owner','admin','employee']::public.company_role[]));
drop policy if exists system_logs_read on public.system_access_logs;
create policy system_logs_read on public.system_access_logs for select to authenticated
  using (public.is_company_member(company_id));

-- ÚNICA regra de negócio. Só wrappers internos podem fornecer a linha.
-- Data de negócio explícita: America/Sao_Paulo, inclusive na virada UTC.
create or replace function public.calculate_system_access(p_system public.client_systems)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_status text := 'active';
  v_due date;
  v_days integer;
  v_remaining integer;
begin
  if not p_system.active then
    v_status := 'suspended';
  elsif p_system.manual_override = 'force_suspended' then
    v_status := 'suspended';
  elsif p_system.manual_override = 'force_active' then
    v_status := 'active';
  elsif p_system.auto_block_enabled and p_system.subscription_id is not null then
    select min(c.due_date) into v_due from public.charges c
    where c.subscription_id = p_system.subscription_id
      and c.company_id = p_system.company_id and c.client_id = p_system.client_id
      and c.status not in ('paid','cancelled')
      and c.due_date < (now() at time zone 'America/Sao_Paulo')::date;
    if v_due is not null then
      v_days := (now() at time zone 'America/Sao_Paulo')::date - v_due;
      if v_days <= p_system.grace_days then
        v_status := 'grace';
        v_remaining := p_system.grace_days - v_days;
      else
        v_status := 'suspended';
      end if;
    end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('allowed', v_status <> 'suspended',
    'status', v_status, 'grace_days_remaining', v_remaining, 'checked_at', now()));
end $$;
revoke all on function public.calculate_system_access(public.client_systems) from public, anon, authenticated;

-- Trigger calcula o snapshot ao cadastrar/editar; consultas usam a mesma função.
create or replace function public.prepare_system_access()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    new.last_status := public.calculate_system_access(new)->>'status';
  elsif (to_jsonb(new) - 'last_status' - 'updated_at') is distinct from
        (to_jsonb(old) - 'last_status' - 'updated_at') then
    new.last_status := public.calculate_system_access(new)->>'status';
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke all on function public.prepare_system_access() from public, anon, authenticated;
drop trigger if exists prepare_system_access on public.client_systems;
create trigger prepare_system_access before insert or update on public.client_systems
  for each row execute function public.prepare_system_access();

create or replace function public.audit_system_access()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_admin boolean;
  v_previous text;
begin
  if TG_OP = 'INSERT' then
    v_admin := true;
  else
    v_previous := old.last_status;
    v_admin := (to_jsonb(new) - 'last_status' - 'updated_at') is distinct from
               (to_jsonb(old) - 'last_status' - 'updated_at');
  end if;
  if v_admin or v_previous is distinct from new.last_status then
    insert into public.system_access_logs(company_id, system_id, previous_status, new_status, reason, source, metadata)
    values(new.company_id, new.id, v_previous, new.last_status,
      case when v_admin then 'system_configuration_changed' else 'access_status_changed' end,
      case when v_admin then 'administration' else 'access_check' end,
      case when v_admin then jsonb_build_object('actor_id', auth.uid(),
        'manual_override', new.manual_override, 'active', new.active,
        'auto_block_enabled', new.auto_block_enabled, 'grace_days', new.grace_days,
        'subscription_id', new.subscription_id,
        'previous_configuration', case when TG_OP = 'UPDATE' then jsonb_build_object(
          'manual_override', old.manual_override, 'active', old.active,
          'auto_block_enabled', old.auto_block_enabled, 'grace_days', old.grace_days,
          'subscription_id', old.subscription_id) else null end)
      else '{}'::jsonb end);
  end if;
  return new;
end $$;
revoke all on function public.audit_system_access() from public, anon, authenticated;
drop trigger if exists audit_system_access on public.client_systems;
create trigger audit_system_access after insert or update on public.client_systems
  for each row execute function public.audit_system_access();

-- Lock serializa consultas e alterações do mesmo sistema, evitando logs duplicados.
-- Inexistente: NULL (Edge retorna 404 sem uma decisão de suspensão).
create or replace function public.get_system_access(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_system public.client_systems; v_result jsonb;
begin
  if p_key is null then return null; end if;
  select * into v_system from public.client_systems where system_key = p_key for update;
  if not found then return null; end if;
  v_result := public.calculate_system_access(v_system);
  if v_system.last_status is distinct from (v_result->>'status') then
    update public.client_systems set last_status = v_result->>'status' where id = v_system.id;
  end if;
  return v_result;
end $$;
revoke all on function public.get_system_access(uuid) from public, anon, authenticated;
grant execute on function public.get_system_access(uuid) to service_role;

-- Painel autenticado recebe a mesma decisão, após autorização por empresa.
create or replace function public.list_system_access(p_company_id uuid, p_client_id uuid default null)
returns table(system_id uuid, access jsonb)
language plpgsql security definer set search_path = public as $$
declare v_row record;
begin
  if not public.is_company_member(p_company_id) then raise exception 'Sem permissão'; end if;
  for v_row in select id, system_key from public.client_systems
    where company_id = p_company_id and (p_client_id is null or client_id = p_client_id)
    order by id
  loop
    system_id := v_row.id;
    access := public.get_system_access(v_row.system_key);
    return next;
  end loop;
end $$;
revoke all on function public.list_system_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_system_access(uuid, uuid) to authenticated;
commit;
