-- ============================================================================
-- Smart Billing — Rollback de sql/vps_worker_automation.sql
-- ----------------------------------------------------------------------------
-- NÃO EXECUTE ESTE ARQUIVO A MENOS QUE REALMENTE PRECISE DESFAZER A
-- PREPARAÇÃO DO WORKER. Ele existe só como plano de contingência revisado
-- e testado (localmente, num Postgres descartável — nunca contra o
-- Supabase de produção).
--
-- O que este rollback FAZ (seguro — não apaga histórico legítimo)
-- ----------------------------------------------------------------------------
-- 1. Restaura claim_whatsapp_jobs() para a definição original (sem as
--    duas higienizações adicionadas na revisão de segurança) — remove
--    também as duas checagens automáticas junto.
-- 2. Remove a função enqueue_whatsapp_message_system() (só era usada pelo
--    worker automático — nada mais no projeto depende dela).
-- 3. Remove a coluna whatsapp_settings.email_reminders_enabled.
-- 4. Remove a coluna notification_logs.idempotency_key.
--
-- Por que isso É seguro
-- ----------------------------------------------------------------------------
-- Nenhuma LINHA de whatsapp_outbox, notification_logs, whatsapp_settings,
-- clients, charges, payments ou receipts é apagada por este script — ele só
-- remove funções/colunas específicas que a preparação do worker adicionou.
-- O histórico de mensagens/logs já enviados (destinatário, texto, status,
-- data de envio) continua intacto; só se perde o VALOR da coluna
-- idempotency_key desses registros (que só servia para o worker automático
-- não repetir envios — sem o worker rodando, esse valor não tem mais
-- função). Nenhum dado de cliente é afetado.
--
-- O que este rollback NÃO faz (de propósito)
-- ----------------------------------------------------------------------------
-- - NÃO apaga nem altera nenhuma linha de whatsapp_outbox ou
--   notification_logs — o histórico de envios permanece 100% legível.
-- - NÃO reverte a correção de "clients.charges ON DELETE CASCADE" (isso é
--   uma correção de bug anterior e não relacionada a este rollback — não
--   deve ser desfeita).
-- - NÃO apaga nenhuma tabela (whatsapp_outbox, whatsapp_settings,
--   notification_logs continuam existindo, só com menos colunas).
--
-- Atenção antes de rodar
-- ----------------------------------------------------------------------------
-- Se o worker JÁ estiver rodando em produção quando você decidir reverter:
--   1. Pare o processo primeiro (pm2 stop smart-billing-worker) — senão ele
--      vai começar a falhar (chamando uma função/coluna que não existe
--      mais) a cada ciclo. As falhas são inofensivas (o worker já trata
--      erro de Supabase sem crashar — ver src/billing.js), mas ficam
--      poluindo o log sem necessidade.
--   2. Depois de rodar este rollback, o Edge Function whatsapp-agent-api
--      publicada continuará tendo as ações list_reminder_candidates/
--      enqueue_reminder/send_email_reminder no código, mas elas passarão a
--      falhar (a função/coluna que usam não existe mais) — considere
--      reverter também o deploy da function para a versão anterior, ou
--      aceitar que essas 3 ações específicas ficam inoperantes.
-- ============================================================================


-- ============================================================================
-- 1. Restaura claim_whatsapp_jobs() para a definição ORIGINAL (antes desta
--    revisão de segurança) — idêntica à primeira versão publicada em
--    sql/whatsapp_agent.sql.
-- ============================================================================
create or replace function public.claim_whatsapp_jobs(p_company_id uuid, p_limit integer default 5)
returns setof public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
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
comment on function public.claim_whatsapp_jobs(uuid, integer) is 'Reivindica atomicamente até p_limit mensagens pendentes de uma empresa (FOR UPDATE SKIP LOCKED). Uso exclusivo da service_role (Edge Function whatsapp-agent-api).';

revoke all on function public.claim_whatsapp_jobs(uuid, integer) from public;
revoke all on function public.claim_whatsapp_jobs(uuid, integer) from anon, authenticated;
grant execute on function public.claim_whatsapp_jobs(uuid, integer) to service_role;


-- ============================================================================
-- 2. Remove enqueue_whatsapp_message_system()
-- ============================================================================
drop function if exists public.enqueue_whatsapp_message_system(uuid, uuid, public.whatsapp_message_type, text, text);


-- ============================================================================
-- 3. Remove whatsapp_settings.email_reminders_enabled
-- ============================================================================
alter table public.whatsapp_settings
  drop column if exists email_reminders_enabled;


-- ============================================================================
-- 4. Remove notification_logs.idempotency_key
-- ============================================================================
alter table public.notification_logs
  drop column if exists idempotency_key;


-- ============================================================================
-- Verificação pós-rollback (opcional, apenas leitura)
-- ============================================================================
select proname from pg_proc where proname = 'enqueue_whatsapp_message_system';
-- (deve retornar 0 linhas)

select column_name from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'whatsapp_settings' and column_name = 'email_reminders_enabled')
    or (table_name = 'notification_logs' and column_name = 'idempotency_key'));
-- (deve retornar 0 linhas)

select count(*) as historico_whatsapp_outbox_preservado from public.whatsapp_outbox;
select count(*) as historico_notification_logs_preservado from public.notification_logs;
-- (ambos devem mostrar a mesma contagem de antes do rollback — nada foi apagado)
