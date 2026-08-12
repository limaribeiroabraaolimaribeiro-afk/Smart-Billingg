-- ============================================================================
-- Smart Billing — Migration: exclusão de cliente em cascata
-- ----------------------------------------------------------------------------
-- Problema corrigido
-- -------------------
-- A foreign key charges.client_id -> clients.id estava definida como
-- "ON DELETE SET NULL". Ao excluir um cliente, as cobranças dele continuavam
-- no banco com client_id = NULL, e a interface passava a exibi-las como
-- "Cliente removido" em Cobranças, Pagamentos, Recibos, Dashboard e
-- Relatórios — em vez de desaparecerem junto com o cliente.
--
-- payments.charge_id, receipts.charge_id e receipts.payment_id já eram
-- "ON DELETE CASCADE" (definidos em sql/supabase_schema.sql apontando para
-- charges/payments), então corrigir apenas o vínculo charges -> clients
-- propaga a cascata pela cadeia inteira em uma única operação atômica:
--
--   clients --CASCADE--> charges --CASCADE--> payments
--                              \----CASCADE--> receipts
--
-- O que este script faz
-- ----------------------
-- Troca SOMENTE a constraint charges.client_id (SET NULL -> CASCADE).
-- Não recria tabelas, não apaga dados, não afeta clientes que não forem
-- excluídos. Idempotente: pode ser executado mais de uma vez sem erro.
--
-- Como aplicar
-- ------------
-- Cole este arquivo inteiro no SQL Editor do seu projeto Supabase e clique
-- em Run. (sql/supabase_schema.sql já foi atualizado com essa mesma
-- definição para instalações novas, mas "create table if not exists" não
-- altera uma tabela que já existe — por isso este script separado é
-- necessário em bancos já provisionados.)
-- ============================================================================

do $$
declare
  v_constraint_name text;
begin
  select tc.constraint_name
    into v_constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name
   and kcu.table_schema = tc.table_schema
  where tc.table_schema = 'public'
    and tc.table_name = 'charges'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'client_id';

  if v_constraint_name is not null then
    execute format('alter table public.charges drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.charges
  add constraint charges_client_id_fkey
  foreign key (client_id) references public.clients (id) on delete cascade;

comment on constraint charges_client_id_fkey on public.charges is
  'Ao excluir um cliente, todas as suas cobranças são excluídas em cascata (e, por consequência, os pagamentos e recibos ligados a essas cobranças).';

-- ============================================================================
-- Verificação pós-migração (opcional, apenas leitura)
-- ----------------------------------------------------------------------------
-- Confirma que a constraint foi aplicada corretamente com delete_rule = CASCADE.
-- ============================================================================
select
  tc.constraint_name,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
 and rc.constraint_schema = tc.table_schema
where tc.table_schema = 'public'
  and tc.table_name = 'charges'
  and tc.constraint_type = 'FOREIGN KEY';

-- ============================================================================
-- Observação sobre dados já existentes
-- ----------------------------------------------------------------------------
-- Este script corrige o comportamento DAQUI PRA FRENTE. Cobranças que já
-- ficaram com client_id = NULL por causa de exclusões feitas ANTES desta
-- correção não são apagadas automaticamente (isso seria uma exclusão de
-- dados financeiros históricos, que não deve ser feita sem confirmação
-- explícita). Se quiser limpar esses registros órfãos antigos, confira
-- manualmente antes de apagar, por exemplo:
--
--   select id, charge_number, description, amount, status, created_at
--   from public.charges
--   where client_id is null;
--
-- e, se realmente desejar removê-los (e seus pagamentos/recibos em
-- cascata, já que payments/receipts referenciam charges com CASCADE):
--
--   delete from public.charges where client_id is null;
