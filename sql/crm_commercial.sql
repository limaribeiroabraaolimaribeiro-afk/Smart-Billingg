-- CRM comercial isolado do Smart Billing financeiro.
-- Usa o MESMO banco Supabase e vincula todos os registros à empresa existente.
-- Somente owners/admins podem acessar; não cria vínculos de consultores ao financeiro.

create table if not exists public.crm_consultants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  email text,
  whatsapp text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(company_id, id)
);

create table if not exists public.crm_leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  consultant_id uuid,
  name text not null check (length(trim(name)) > 0),
  company_name text,
  whatsapp text,
  email text,
  source text,
  service text,
  estimated_value numeric(12,2) not null default 0 check (estimated_value >= 0),
  status text not null default 'novo' check (status in ('novo','contato','proposta','negociacao','ganho','perdido')),
  next_contact_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique(company_id, id),
  foreign key (company_id, consultant_id) references public.crm_consultants(company_id,id)
);

create table if not exists public.crm_sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  lead_id uuid,
  consultant_id uuid not null,
  customer_name text not null check (length(trim(customer_name)) > 0),
  service text not null check (length(trim(service)) > 0),
  amount numeric(12,2) not null check (amount > 0),
  sold_at date not null default current_date,
  status text not null default 'fechada' check (status in ('fechada','cancelada')),
  notes text,
  created_at timestamptz not null default now(),
  foreign key (company_id, consultant_id) references public.crm_consultants(company_id,id),
  foreign key (company_id, lead_id) references public.crm_leads(company_id,id)
);

create table if not exists public.crm_meetings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  lead_id uuid,
  consultant_id uuid,
  title text not null check (length(trim(title)) > 0),
  starts_at timestamptz not null,
  meeting_type text not null default 'online' check (meeting_type in ('online','presencial','telefone')),
  location text,
  status text not null default 'agendada' check (status in ('agendada','realizada','cancelada')),
  notes text,
  created_at timestamptz not null default now(),
  foreign key (company_id, consultant_id) references public.crm_consultants(company_id,id),
  foreign key (company_id, lead_id) references public.crm_leads(company_id,id)
);

create index if not exists crm_consultants_company_idx on public.crm_consultants(company_id);
create index if not exists crm_leads_company_status_idx on public.crm_leads(company_id,status);
create index if not exists crm_leads_company_consultant_idx on public.crm_leads(company_id,consultant_id);
create index if not exists crm_sales_company_sold_idx on public.crm_sales(company_id,sold_at);
create index if not exists crm_sales_company_consultant_idx on public.crm_sales(company_id,consultant_id);
create index if not exists crm_meetings_company_date_idx on public.crm_meetings(company_id,starts_at);

alter table public.crm_consultants enable row level security;
alter table public.crm_leads enable row level security;
alter table public.crm_sales enable row level security;
alter table public.crm_meetings enable row level security;

-- Reutiliza a função segura já existente no Smart Billing.
-- Não concede permissão nova às tabelas financeiras.
create policy crm_consultants_management on public.crm_consultants
 for all to authenticated
 using (public.has_company_role(company_id, array['owner','admin']::public.company_role[]))
 with check (public.has_company_role(company_id, array['owner','admin']::public.company_role[]));
create policy crm_leads_management on public.crm_leads
 for all to authenticated
 using (public.has_company_role(company_id, array['owner','admin']::public.company_role[]))
 with check (public.has_company_role(company_id, array['owner','admin']::public.company_role[]));
create policy crm_sales_management on public.crm_sales
 for all to authenticated
 using (public.has_company_role(company_id, array['owner','admin']::public.company_role[]))
 with check (public.has_company_role(company_id, array['owner','admin']::public.company_role[]));
create policy crm_meetings_management on public.crm_meetings
 for all to authenticated
 using (public.has_company_role(company_id, array['owner','admin']::public.company_role[]))
 with check (public.has_company_role(company_id, array['owner','admin']::public.company_role[]));

grant select, insert, update, delete on public.crm_consultants to authenticated;
grant select, insert, update, delete on public.crm_leads to authenticated;
grant select, insert, update, delete on public.crm_sales to authenticated;
grant select, insert, update, delete on public.crm_meetings to authenticated;
