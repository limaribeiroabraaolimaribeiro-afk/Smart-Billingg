-- ============================================================================
-- Smart Billing — Dados de demonstração (OPCIONAL)
-- ----------------------------------------------------------------------------
-- Este arquivo NÃO roda automaticamente junto com sql/supabase_schema.sql.
-- Execute-o separadamente, e somente depois de:
--   1. Ter executado sql/supabase_schema.sql inteiro;
--   2. Ter criado o primeiro usuário (login.html → "Criar conta", ou pelo
--      painel Authentication > Users do Supabase);
--   3. Saber o ID da empresa criada automaticamente para esse usuário.
--
-- Como descobrir o ID da sua empresa:
--   select id, name, owner_id from public.companies;
--
-- Este script define a função public.seed_demo_data(company_id), que só
-- insere clientes/cobranças/pagamentos vinculados à empresa informada —
-- ele NUNCA inventa um company_id sozinho, evitando dados órfãos ou
-- associados à empresa errada.
-- ============================================================================

create or replace function public.seed_demo_data(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cliente_1 uuid;
  v_cliente_2 uuid;
  v_cliente_3 uuid;
  v_charge_1  uuid;
  v_charge_2  uuid;
  v_payment_1 uuid;
begin
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa % não encontrada. Confira o ID antes de rodar o seed.', p_company_id;
  end if;

  -- Clientes de demonstração
  insert into public.clients (company_id, name, email, whatsapp, status)
  values (p_company_id, 'Marina Souza Alves', 'marina.alves@email.com', '11987654321', 'active')
  returning id into v_cliente_1;

  insert into public.clients (company_id, name, email, whatsapp, status)
  values (p_company_id, 'Studio Nova Design Ltda', 'contato@studionova.com', '11965432109', 'active')
  returning id into v_cliente_2;

  insert into public.clients (company_id, name, email, whatsapp, status)
  values (p_company_id, 'Carlos Eduardo Lima', 'carlos.lima@email.com', '21976543210', 'active')
  returning id into v_cliente_3;

  -- Cobrança paga (com pagamento + recibo)
  insert into public.charges (company_id, client_id, description, amount, due_date, status, payment_methods, max_installments, paid_at)
  values (p_company_id, v_cliente_2, 'Projeto de identidade visual completa', 4200.00, current_date - 3, 'paid', '["pix"]'::jsonb, 1, now() - interval '2 days')
  returning id into v_charge_1;

  insert into public.payments (company_id, charge_id, provider, payment_method, installments, gross_amount, fee_amount, net_amount, status, paid_at)
  values (p_company_id, v_charge_1, 'manual', 'pix', 1, 4200.00, 0, 4200.00, 'approved', now() - interval '2 days')
  returning id into v_payment_1;

  insert into public.receipts (company_id, charge_id, payment_id, receipt_number, issued_at)
  values (p_company_id, v_charge_1, v_payment_1, 'REC-000001', now() - interval '2 days');

  -- Cobrança pendente
  insert into public.charges (company_id, client_id, description, amount, due_date, status, payment_methods, max_installments)
  values (p_company_id, v_cliente_1, 'Consultoria de marketing digital — mês atual', 1850.00, current_date + 5, 'pending', '["pix", "cartao"]'::jsonb, 3)
  returning id into v_charge_2;

  -- Cobrança atrasada
  insert into public.charges (company_id, client_id, description, amount, due_date, status, payment_methods, max_installments)
  values (p_company_id, v_cliente_3, 'Mensalidade plano Premium', 349.90, current_date - 6, 'pending', '["cartao"]'::jsonb, 3);

  -- Cobrança cancelada
  insert into public.charges (company_id, client_id, description, amount, due_date, status, payment_methods, cancelled_at)
  values (p_company_id, v_cliente_2, 'Manual de marca — revisão (cancelado)', 950.00, current_date - 20, 'cancelled', '["pix"]'::jsonb, now() - interval '10 days');

  raise notice 'Seed de demonstração criado para a empresa %.', p_company_id;
end;
$$;

comment on function public.seed_demo_data(uuid) is
  'Insere clientes e cobranças de demonstração para UMA empresa específica. Não roda sozinho — chame manualmente.';

grant execute on function public.seed_demo_data(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Depois de rodar o bloco acima (que só cria a função), execute por último,
-- substituindo pelo ID real da sua empresa:
--
--   select public.seed_demo_data('COLE-AQUI-O-ID-DA-EMPRESA'::uuid);
--
-- Rodar novamente com o mesmo ID vai duplicar os dados de demonstração —
-- se quiser recomeçar, apague manualmente os registros de teste antes.
-- ----------------------------------------------------------------------------
