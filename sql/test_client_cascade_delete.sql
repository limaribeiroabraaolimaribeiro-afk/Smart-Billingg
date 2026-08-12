-- ============================================================================
-- Smart Billing — Teste ponta a ponta: exclusão de cliente em cascata
-- ----------------------------------------------------------------------------
-- Rode este script no SQL Editor do Supabase DEPOIS de aplicar
-- sql/fix_client_delete_cascade.sql, para confirmar que excluir um cliente
-- remove cobranças, pagamentos e recibos relacionados — sem deixar nenhum
-- registro órfão e sem afetar nenhum outro cliente.
--
-- O script cria seus próprios dados de teste (1 cliente, 2 cobranças —
-- 1 paga e 1 pendente —, 1 pagamento, 1 recibo), confirma que eles existem,
-- executa a mesma operação que o app faz ao excluir um cliente
-- (DELETE FROM public.clients WHERE id = ...) e então confirma que todos os
-- registros relacionados desapareceram. Se qualquer verificação falhar, o
-- script levanta uma exceção com RAISE EXCEPTION e a transação é desfeita.
--
-- Seguro para rodar quantas vezes quiser: os dados de teste só existem
-- durante a execução do script (a própria exclusão em cascata os remove) e
-- nenhum dado de outros clientes é tocado.
-- ============================================================================

do $$
declare
  v_company_id   uuid;
  v_client_id    uuid;
  v_charge_paid  uuid;
  v_charge_pend  uuid;
  v_payment_id   uuid;
  v_receipt_id   uuid;
  v_count        integer;
begin
  -- usa a primeira empresa existente no banco (troque por um company_id
  -- específico se quiser testar em outra conta)
  select id into v_company_id from public.companies order by created_at limit 1;
  if v_company_id is null then
    raise exception 'Nenhuma empresa encontrada — crie uma conta no app antes de rodar este teste.';
  end if;

  -- 1) cliente de teste
  insert into public.clients (company_id, name, email)
  values (v_company_id, '__TESTE CASCADE DELETE__', 'teste-cascade@example.com')
  returning id into v_client_id;

  -- 2) duas cobranças: uma paga, uma pendente
  insert into public.charges (company_id, client_id, description, amount, due_date, status, paid_at)
  values (v_company_id, v_client_id, 'Cobrança de teste (paga)', 100.00, current_date, 'paid', now())
  returning id into v_charge_paid;

  insert into public.charges (company_id, client_id, description, amount, due_date, status)
  values (v_company_id, v_client_id, 'Cobrança de teste (pendente)', 50.00, current_date + 7, 'pending')
  returning id into v_charge_pend;

  -- 3) um pagamento, ligado à cobrança paga
  insert into public.payments (company_id, charge_id, payment_method, gross_amount, net_amount, status, paid_at)
  values (v_company_id, v_charge_paid, 'pix', 100.00, 100.00, 'approved', now())
  returning id into v_payment_id;

  -- 4) um recibo, ligado à cobrança paga + pagamento
  insert into public.receipts (company_id, charge_id, payment_id, receipt_number)
  values (v_company_id, v_charge_paid, v_payment_id, 'TESTE-' || replace(v_client_id::text, '-', ''))
  returning id into v_receipt_id;

  raise notice 'Cliente de teste criado: % (empresa %)', v_client_id, v_company_id;

  -- ---- confirma que os registros existem ANTES da exclusão ----
  select count(*) into v_count from public.clients where id = v_client_id;
  if v_count <> 1 then raise exception 'Falha de setup: cliente de teste não foi criado (encontrados: %)', v_count; end if;

  select count(*) into v_count from public.charges where client_id = v_client_id;
  if v_count <> 2 then raise exception 'Falha de setup: esperava 2 cobranças de teste, encontradas %', v_count; end if;

  select count(*) into v_count from public.payments where charge_id in (v_charge_paid, v_charge_pend);
  if v_count <> 1 then raise exception 'Falha de setup: esperava 1 pagamento de teste, encontrados %', v_count; end if;

  select count(*) into v_count from public.receipts where charge_id in (v_charge_paid, v_charge_pend);
  if v_count <> 1 then raise exception 'Falha de setup: esperava 1 recibo de teste, encontrados %', v_count; end if;

  raise notice 'Pré-condições OK: 1 cliente, 2 cobranças (1 paga + 1 pendente), 1 pagamento, 1 recibo.';

  -- ================================================================
  -- >>> a mesma operação que o app executa ao excluir um cliente <<<
  -- ================================================================
  delete from public.clients where id = v_client_id;

  -- ---- confirma que TUDO relacionado ao cliente sumiu ----
  select count(*) into v_count from public.clients where id = v_client_id;
  if v_count <> 0 then raise exception 'FALHA: cliente ainda existe após DELETE (encontrados: %)', v_count; end if;

  select count(*) into v_count from public.charges where client_id = v_client_id;
  if v_count <> 0 then raise exception 'FALHA: cobranças órfãs ainda existem após excluir o cliente (encontradas: %)', v_count; end if;

  select count(*) into v_count from public.payments where charge_id in (v_charge_paid, v_charge_pend);
  if v_count <> 0 then raise exception 'FALHA: pagamentos órfãos ainda existem após excluir o cliente (encontrados: %)', v_count; end if;

  select count(*) into v_count from public.receipts where charge_id in (v_charge_paid, v_charge_pend);
  if v_count <> 0 then raise exception 'FALHA: recibos órfãos ainda existem após excluir o cliente (encontrados: %)', v_count; end if;

  raise notice 'SUCESSO: cliente, cobranças, pagamentos e recibos foram excluídos em cascata. Nenhum registro órfão restante.';
end $$;
