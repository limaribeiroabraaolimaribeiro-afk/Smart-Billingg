-- ============================================================================
-- Smart Billing — Limpeza de cobranças órfãs (client_id IS NULL)
-- ----------------------------------------------------------------------------
-- ATENÇÃO: este script APAGA dados permanentemente. NÃO é executado
-- automaticamente por nada no projeto — revise cada bloco antes de rodar.
--
-- Rode sql/diagnose_orphan_charges.sql PRIMEIRO para ver exatamente quais
-- cobranças (e pagamentos/recibos ligados a elas) serão removidas por este
-- script antes de decidir executá-lo.
--
-- O que este script apaga
-- ------------------------
-- Cobranças (public.charges) com client_id IS NULL — ou seja, cobranças que
-- ficaram "penduradas" no banco por causa do antigo comportamento
-- "ON DELETE SET NULL" em exclusões de cliente feitas ANTES da correção
-- (sql/fix_client_delete_cascade.sql). O formulário de nova cobrança sempre
-- exige um cliente, então não existe cobrança legítima com client_id NULL
-- no fluxo normal do app — todo registro encontrado aqui é resíduo de uma
-- exclusão antiga.
--
-- payments.charge_id e receipts.charge_id/payment_id já são
-- "ON DELETE CASCADE" (isso não depende da correção de client_id — é a
-- constraint charges -> payments/receipts, que já existia assim desde o
-- schema original). Por isso, apagar essas cobranças órfãs remove os
-- pagamentos e recibos ligados a elas automaticamente, na mesma instrução,
-- sem necessidade de apagar cada tabela manualmente.
--
-- O que este script NUNCA apaga
-- -------------------------------
-- Nenhum cliente. Nenhuma cobrança com client_id preenchido (ou seja,
-- nenhum dado de nenhum cliente ativo é tocado). O filtro "client_id is
-- null" é a única condição usada em todo o script.
--
-- Como usar com segurança
-- ------------------------
-- 1. Rode sql/diagnose_orphan_charges.sql e confira os números.
-- 2. Se quiser testar antes de confirmar de verdade, rode manualmente:
--      begin;
--      -- (cole o bloco "DELETE" abaixo aqui)
--      -- confira os SELECTs de verificação no final
--      rollback;   -- desfaz tudo, nada é gravado
--    Troque "rollback" por "commit" só quando tiver certeza.
-- 3. Ou rode o script inteiro direto (sem begin/rollback manual) — cada
--    DELETE abaixo já é atômico por si só.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Pré-visualização (mesma contagem do diagnóstico, para conferir antes do
-- DELETE dentro desta mesma execução)
-- ----------------------------------------------------------------------------
select
  count(*) as cobrancas_orfas_a_remover,
  coalesce(sum(amount), 0) as valor_total_envolvido
from public.charges
where client_id is null;

-- ----------------------------------------------------------------------------
-- A exclusão em si.
-- Remove as cobranças órfãs; payments/receipts ligados a elas são
-- removidos em cascata pelo próprio Postgres (ON DELETE CASCADE já
-- existente em payments.charge_id e receipts.charge_id/payment_id).
-- ----------------------------------------------------------------------------
delete from public.charges
where client_id is null;

-- ----------------------------------------------------------------------------
-- Verificação pós-limpeza — todas as consultas abaixo devem retornar 0.
-- ----------------------------------------------------------------------------
select count(*) as cobrancas_orfas_restantes
from public.charges
where client_id is null;

select count(*) as pagamentos_orfaos_restantes
from public.payments p
where not exists (select 1 from public.charges c where c.id = p.charge_id);

select count(*) as recibos_orfaos_restantes
from public.receipts r
where not exists (select 1 from public.charges c where c.id = r.charge_id);
