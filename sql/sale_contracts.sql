-- Contratos eletrônicos de venda particular (fluxo separado das cobranças).
-- Dados e PDFs são privados: o navegador usa apenas a Edge Function autorizadora.
create table if not exists public.sale_contracts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  token_hash text unique not null,
  status text not null default 'pending' check (status in ('pending','signing','signed')),
  seller_name text not null,
  seller_cpf text not null,
  seller_address text not null,
  seller_email text not null,
  seller_signature_path text not null,
  buyer_name text,
  buyer_cpf text,
  buyer_address text,
  buyer_email text,
  buyer_phone text,
  buyer_signature_path text,
  product_description text not null default 'Notebook ASUS Core i3 usado',
  product_serial text not null,
  product_condition text not null,
  accessories text not null default 'Não informado',
  pix_key text not null,
  first_due_date date not null,
  installment_cents integer not null default 18500 check (installment_cents = 18500),
  installment_count integer not null default 10 check (installment_count = 10),
  total_cents integer generated always as (installment_cents * installment_count) stored,
  signed_at timestamptz,
  signed_ip text,
  signed_user_agent text,
  consent_version text,
  pdf_path text,
  pdf_sha256 text,
  email_buyer_status text,
  email_seller_status text,
  created_at timestamptz not null default now(),
  constraint signed_evidence_required check (
    status <> 'signed' or
    (signed_at is not null and pdf_path is not null and pdf_sha256 is not null and buyer_name is not null and buyer_cpf is not null)
  )
);
create index if not exists idx_sale_contracts_owner_created on public.sale_contracts(company_id,created_at desc);
alter table public.sale_contracts enable row level security;
revoke all on public.sale_contracts from anon, authenticated;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('sale-contracts-private','sale-contracts-private',false,5242880,array['application/pdf','image/png'])
on conflict (id) do update set public = false;
-- Sem políticas de storage.objects para usuários: acesso somente por URLs temporárias após autorização do backend.
