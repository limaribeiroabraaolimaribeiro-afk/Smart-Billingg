
-- Evidências documentais vinculadas a contratos de venda, somente service_role.
create table if not exists public.sale_contract_evidence (
 id uuid primary key default gen_random_uuid(),
 contract_id uuid not null references public.sale_contracts(id) on delete restrict,
 company_id uuid not null references public.companies(id) on delete restrict,
 uploaded_by uuid not null references auth.users(id) on delete restrict,
 original_name text not null,
 storage_path text not null unique,
 mime_type text not null check(mime_type in ('image/jpeg','image/png','application/pdf')),
 file_size integer not null check(file_size > 0 and file_size <= 5242880),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique(contract_id,sha256)
);
create index if not exists idx_sale_contract_evidence_contract on public.sale_contract_evidence(contract_id,created_at);
alter table public.sale_contract_evidence enable row level security;
revoke all on public.sale_contract_evidence from anon, authenticated;
update storage.buckets
  set allowed_mime_types = array['application/pdf','image/png','image/jpeg'],
      file_size_limit = 5242880
  where id='sale-contracts-private';
-- bucket continua privado; anexos acessíveis apenas via URL temporária emitida para administrador.
