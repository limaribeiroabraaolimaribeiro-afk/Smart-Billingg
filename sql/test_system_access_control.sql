-- Executar em ambiente de teste após system_access_control.sql, como postgres.
-- Fixtures isoladas. ROLLBACK remove tudo; nenhuma cobrança real é alterada.
begin;
create function pg_temp.expect_access(k uuid, expected text) returns void language plpgsql as $$
declare r jsonb;
begin
  r := public.get_system_access(k);
  if r is null or r->>'status' <> expected or (r->>'allowed')::boolean <> (expected <> 'suspended') then
    raise exception 'Esperava %, recebido %', expected, r;
  end if;
end $$;

do $$
declare
  u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); viewer uuid := gen_random_uuid();
  co uuid; co2 uuid; cl uuid; cl2 uuid; other_client uuid; plan uuid;
  sub uuid; sub2 uuid; sid uuid; k uuid; ch uuid; extra uuid; count_before integer;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  result jsonb;
begin
  insert into auth.users(id,email) values(u,'system-access-test@example.invalid'),
    (u2,'system-access-test-2@example.invalid'), (viewer,'system-access-viewer@example.invalid');
  select id into co from public.companies where owner_id=u;
  select id into co2 from public.companies where owner_id=u2;
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.company_members(company_id,user_id,role) values(co,viewer,'viewer');
  insert into public.clients(company_id,name) values(co,'Access test') returning id into cl;
  insert into public.clients(company_id,name) values(co,'Other client') returning id into other_client;
  insert into public.clients(company_id,name) values(co2,'Other company') returning id into cl2;
  insert into public.billing_plans(company_id,name,amount,duration_months,billing_type)
    values(co,'Access test',100,1,'recurring_monthly') returning id into plan;
  insert into public.client_subscriptions(company_id,client_id,plan_id) values(co,cl,plan) returning id into sub;
  insert into public.client_subscriptions(company_id,client_id,plan_id) values(co,cl,plan) returning id into sub2;
  insert into public.client_systems(company_id,client_id,subscription_id,name)
    values(co,cl,sub,'Access test') returning id,system_key into sid,k;
  insert into public.charges(company_id,client_id,subscription_id,description,amount,due_date)
    values(co,cl,sub,'Access test',100,today) returning id into ch;
  perform pg_temp.expect_access(k,'active'); -- A
  update public.charges set due_date=today-1 where id=ch;
  perform pg_temp.expect_access(k,'grace'); -- B
  result := public.get_system_access(k);
  assert (result->>'grace_days_remaining')::int=2, 'B: dias restantes';
  update public.charges set due_date=today-3 where id=ch;
  perform pg_temp.expect_access(k,'grace'); -- C
  update public.charges set due_date=today-4 where id=ch;
  perform pg_temp.expect_access(k,'suspended'); -- D
  select count(*) into count_before from public.system_access_logs where system_id=sid;
  perform public.get_system_access(k); perform public.get_system_access(k);
  assert (select count(*) from public.system_access_logs where system_id=sid)=count_before, 'Logs repetidos';
  -- E: usa registro de pagamento real já existente, sem webhook novo.
  perform public.register_manual_payment(ch,'pix',1);
  perform pg_temp.expect_access(k,'active');
  assert (select amount from public.charges where id=ch)=100, 'Valor original alterado';
  assert exists(select 1 from public.payments where charge_id=ch), 'Pagamento não registrado';
  update public.charges set status='cancelled' where id=ch;
  perform pg_temp.expect_access(k,'active'); -- F
  insert into public.charges(company_id,client_id,description,amount,due_date)
    values(co,cl,'Avulsa atrasada',20,today-100) returning id into extra;
  perform pg_temp.expect_access(k,'active'); -- G
  update public.charges set subscription_id=sub2 where id=extra;
  perform pg_temp.expect_access(k,'active'); -- H
  update public.charges set status='pending' where id=ch;
  update public.client_systems set manual_override='force_active' where id=sid;
  perform pg_temp.expect_access(k,'active'); -- I
  update public.charges set status='paid' where id=ch;
  update public.client_systems set manual_override='force_suspended' where id=sid;
  perform pg_temp.expect_access(k,'suspended'); -- J
  update public.client_systems set manual_override='none',auto_block_enabled=false where id=sid;
  update public.charges set status='pending' where id=ch;
  perform pg_temp.expect_access(k,'active'); -- K
  assert public.get_system_access(gen_random_uuid()) is null, 'L: chave inexistente';
  update public.client_systems set active=false,manual_override='force_active' where id=sid;
  perform pg_temp.expect_access(k,'suspended'); -- M: inativo precede override
  update public.client_systems set active=true,manual_override='none',auto_block_enabled=true where id=sid;
  -- O: cancelamento/expiração da assinatura não perdoa nem cria dívida.
  update public.client_subscriptions set status='cancelled' where id=sub;
  perform pg_temp.expect_access(k,'suspended');
  update public.client_subscriptions set status='expired' where id=sub;
  perform pg_temp.expect_access(k,'suspended');
  update public.charges set status='cancelled' where id=ch;
  perform pg_temp.expect_access(k,'active');
  -- Mais antiga relevante prevalece, mesmo quando há outra em carência.
  update public.charges set status='pending',due_date=today-1 where id=ch;
  update public.charges set subscription_id=sub where id=extra;
  perform pg_temp.expect_access(k,'suspended');
  update public.charges set status='cancelled' where id=extra;
  perform pg_temp.expect_access(k,'grace');
  update public.client_systems set grace_days=0 where id=sid;
  perform pg_temp.expect_access(k,'suspended');
  -- Pagamento divergente em revisão não quita a cobrança nem libera acesso.
  perform public.register_infinitepay_payment(ch,'review-test-'||gen_random_uuid()::text,'pix',1,1,1,null,'{}');
  perform pg_temp.expect_access(k,'suspended');
  -- Confirmação InfinitePay usa o mesmo estado da cobrança.
  perform public.register_infinitepay_payment(ch,'access-test-'||gen_random_uuid()::text,'pix',1,
    (select coalesce(updated_amount,amount)*100 from public.charges where id=ch)::bigint,10000,null,'{}');
  perform pg_temp.expect_access(k,'active');

  -- Integridade multiempresa e mesmo cliente, inclusive SQL direto.
  begin
    insert into public.client_systems(company_id,client_id,subscription_id,name) values(co,other_client,sub,'invalid');
    raise exception 'Aceitou assinatura de outro cliente';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.client_systems(company_id,client_id,name) values(co,cl2,'invalid');
    raise exception 'Aceitou cliente de outra empresa';
  exception when foreign_key_violation then null; end;
  begin
    update public.client_systems set grace_days=-1 where id=sid;
    raise exception 'Aceitou carência negativa';
  exception when check_violation then null; end;

  -- RLS/GRANT efetivos, não apenas inspeção textual das policies.
  execute 'set local role anon';
  begin perform * from public.client_systems; raise exception 'Anon leu sistemas';
  exception when insufficient_privilege then null; end;
  begin perform * from public.system_access_logs; raise exception 'Anon leu logs';
  exception when insufficient_privilege then null; end;
  begin perform public.get_system_access(k); raise exception 'Anon executou RPC';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',u2::text,true);
  execute 'set local role authenticated';
  assert not exists(select 1 from public.client_systems where id=sid), 'RLS vazou sistema';
  assert not exists(select 1 from public.system_access_logs where system_id=sid), 'RLS vazou logs';
  begin perform public.list_system_access(co); raise exception 'RPC vazou outra empresa';
  exception when raise_exception then if SQLERRM <> 'Sem permissão' then raise; end if; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',viewer::text,true);
  execute 'set local role authenticated';
  assert exists(select 1 from public.client_systems where id=sid), 'Viewer não leu';
  update public.client_systems set name='forbidden' where id=sid;
  assert (select name from public.client_systems where id=sid)='Access test', 'Viewer editou';
  begin
    insert into public.client_systems(company_id,client_id,name) values(co,cl,'forbidden');
    raise exception 'Viewer criou';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',u::text,true);
  execute 'set local role authenticated';
  update public.client_systems set name='Owner edit' where id=sid;
  assert (select name from public.client_systems where id=sid)='Owner edit', 'Owner não editou';
  perform * from public.list_system_access(co);
  begin update public.client_systems set last_status='suspended' where id=sid; raise exception 'Forjou snapshot';
  exception when insufficient_privilege then null; end;
  begin update public.client_systems set system_key=gen_random_uuid() where id=sid; raise exception 'Forjou chave';
  exception when insufficient_privilege then null; end;
  begin delete from public.system_access_logs where system_id=sid; raise exception 'Apagou auditoria';
  exception when insufficient_privilege then null; end;
  begin perform public.get_system_access(k); raise exception 'Authenticated executou RPC público';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  -- Employee/admin seguem os mesmos papéis autorizados dos planos existentes.
  update public.company_members set role='employee' where company_id=co and user_id=viewer;
  perform set_config('request.jwt.claim.sub',viewer::text,true);
  execute 'set local role authenticated';
  update public.client_systems set name='Employee edit' where id=sid;
  assert (select name from public.client_systems where id=sid)='Employee edit', 'Employee não editou';
  execute 'reset role';
  update public.company_members set role='admin' where company_id=co and user_id=viewer;
  execute 'set local role authenticated';
  update public.client_systems set name='Admin edit' where id=sid;
  assert (select name from public.client_systems where id=sid)='Admin edit', 'Admin não editou';
  execute 'reset role';
  execute 'set local role service_role';
  perform public.get_system_access(k);
  execute 'reset role';

  delete from public.client_subscriptions where id=sub;
  assert (select subscription_id from public.client_systems where id=sid) is null, 'O: assinatura removida';
  perform pg_temp.expect_access(k,'active');
  delete from public.clients where id=cl;
  assert not exists(select 1 from public.client_systems where id=sid), 'N: sistema órfão';
  assert not exists(select 1 from public.system_access_logs where system_id=sid), 'N: log órfão';
end $$;
rollback;
