-- ============================================================================
-- Smart Billing — Backfill de corte (cutover) para o novo dedup por cliente/dia
-- ----------------------------------------------------------------------------
-- ESTE SCRIPT AINDA NÃO FOI EXECUTADO. NÃO É genérico/permanente como
-- sql/fix_daily_reminder_dedup.sql — é um script de UMA VEZ SÓ, sensível à
-- data/hora em que for rodado ("hoje" = o dia local no momento da execução).
--
-- Por quê isso existe
-- ----------------------------------------------------------------------------
-- Antes desta correção, o sistema antigo enfileirava um WhatsApp por
-- COBRANÇA elegível (idempotency_key = "reminder:<charge_id>:<kind>"). Se
-- ele já rodou hoje (antes de você aplicar sql/fix_daily_reminder_dedup.sql
-- e reiniciar o worker), alguns clientes já podem ter RECEBIDO 1, 2 ou 3
-- lembretes automáticos hoje.
--
-- O novo sistema usa uma chave por CLIENTE/DIA
-- ("daily-reminder:<company_id>:<client_id>:<data local>"), que é
-- COMPLETAMENTE DIFERENTE da chave antiga. Sem este backfill, na primeira
-- vez que o worker novo rodar hoje, ele NÃO reconhece os lembretes antigos
-- já enviados — a chave nova nunca existiu, então o INSERT ... ON CONFLICT
-- não teria nada para colidir, e o cliente receberia uma 4ª mensagem
-- (o resumo consolidado) no mesmo dia. Este script fecha exatamente essa
-- lacuna, ANTES de você reiniciar o worker.
--
-- O que este script faz
-- ----------------------------------------------------------------------------
-- Para cada cliente que já tem, HOJE (America/Sao_Paulo), pelo menos um
-- registro de lembrete AUTOMÁTICO (message_type IN ('due_soon_reminder',
-- 'overdue_reminder')) com status 'sent' (já entregue), 'processing'
-- (sendo entregue agora) ou 'pending' (ainda na fila, será entregue pelo
-- pipeline antigo, sem alteração, em instantes) — insere uma linha
-- "placeholder" já com status 'cancelled' e a chave diária
-- correspondente. Essa linha nunca é processada (já nasce cancelada); ela
-- serve só para ocupar o lugar de "daily-reminder:<empresa>:<cliente>:hoje"
-- na constraint UNIQUE de idempotency_key — assim, quando o worker novo
-- tentar enfileirar o resumo diário desse cliente hoje, o
-- ON CONFLICT (idempotency_key) DO NOTHING silenciosamente não cria nada
-- novo (mesmo mecanismo que já protege o dia a dia normal do sistema).
--
-- Mensagens com status 'cancelled' ou 'failed' de hoje NÃO contam (não
-- houve entrega nem nada em andamento — bloquear esses clientes seria uma
-- restrição nova, não pedida, que poderia deixá-los sem nenhum lembrete
-- hoje). Cobrança nova (charge), recibo (receipt), teste (test) e mensagem
-- avulsa (custom) NUNCA entram nesta conta — só due_soon_reminder/
-- overdue_reminder, exatamente como pedido.
--
-- IMPORTANTE — mensagens manuais também NÃO contam: o painel permite que um
-- humano dispare manualmente um "lembrete de vencimento" (mesmo
-- message_type due_soon_reminder/overdue_reminder) pelo botão de cobrança
-- avulsa. Essas linhas são diferenciadas das automáticas pela coluna
-- whatsapp_outbox.created_by: enqueue_whatsapp_message() (painel, usuário
-- logado) sempre grava auth.uid() ali; o antigo enqueue_whatsapp_message()
-- chamado automaticamente pelo worker antigo NUNCA grava created_by (fica
-- NULL). Por isso o filtro abaixo exige created_by IS NULL — sem isso, um
-- envio manual feito hoje bloquearia indevidamente o resumo automático
-- desse cliente, o que o pedido original excluiu explicitamente.
--
-- As mensagens antigas ainda 'pending'/'processing' na fila NÃO são
-- tocadas nem canceladas por este script — elas continuam sendo entregues
-- normalmente pelo pipeline já existente (claim_whatsapp_jobs +
-- queue.js), sem nenhuma alteração de comportamento. O que este script
-- evita é APENAS a criação de uma mensagem NOVA (o resumo consolidado)
-- para um cliente que já foi (ou está sendo, ou será em segundos)
-- alcançado hoje pelo sistema antigo.
--
-- Cobre WhatsApp (whatsapp_outbox) e, pela mesma lógica, e-mail
-- (notification_logs) — o e-mail automático depende de
-- email_reminders_enabled estar ligado; se nenhuma empresa tinha isso
-- ligado ainda, a segunda parte deste script simplesmente não insere nada.
--
-- Como aplicar
-- ------------
-- 1. Rode isto DEPOIS de sql/fix_daily_reminder_dedup.sql e ANTES de
--    reiniciar/atualizar o worker na VPS (ou antes do primeiro
--    "pm2 restart smart-billing-worker" do dia).
-- 2. Rode só HOJE — não faz sentido rodar em outro dia (o filtro de data é
--    sempre "o dia local no momento da execução"). Se dias diferentes
--    tiverem o mesmo problema (o worker ficou desligado e foi religado em
--    outro dia depois de já ter rodado hoje), rode de novo nesse dia
--    específico — é idempotente, seguro rodar mais de uma vez.
-- ============================================================================


-- ============================================================================
-- 1. Pré-visualização — quantos clientes seriam bloqueados, e por quê
--    (rode isso primeiro para conferir antes de decidir aplicar)
-- ============================================================================
select
  o.company_id,
  o.client_id,
  count(*) as lembretes_automaticos_hoje,
  array_agg(distinct o.status) as status_encontrados,
  array_agg(distinct o.message_type) as tipos_encontrados
from public.whatsapp_outbox o
where o.message_type in ('due_soon_reminder', 'overdue_reminder')
  and o.status in ('sent', 'processing', 'pending')
  and o.client_id is not null
  and o.created_by is null
  and (coalesce(o.sent_at, o.created_at) at time zone 'America/Sao_Paulo')::date
      = (now() at time zone 'America/Sao_Paulo')::date
group by o.company_id, o.client_id
order by o.company_id, o.client_id;


-- ============================================================================
-- 2. Backfill — WhatsApp (whatsapp_outbox)
-- ============================================================================
insert into public.whatsapp_outbox (
  company_id, client_id, recipient, message, message_type, status,
  idempotency_key, error_message
)
select
  o.company_id,
  o.client_id,
  cl.whatsapp,
  '[migração] Bloqueio preventivo — cliente já recebeu lembrete(s) automático(s) de WhatsApp hoje pelo sistema anterior.',
  'daily_reminder',
  'cancelled',
  'daily-reminder:' || o.company_id::text || ':' || o.client_id::text || ':'
    || to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
  'Backfill de corte (cutover) — ver sql/backfill_daily_reminder_cutover_today.sql.'
from (
  select distinct o.company_id, o.client_id
  from public.whatsapp_outbox o
  where o.message_type in ('due_soon_reminder', 'overdue_reminder')
    and o.status in ('sent', 'processing', 'pending')
    and o.client_id is not null
    and o.created_by is null
    and (coalesce(o.sent_at, o.created_at) at time zone 'America/Sao_Paulo')::date
        = (now() at time zone 'America/Sao_Paulo')::date
) o
join public.clients cl on cl.id = o.client_id
on conflict (idempotency_key) do nothing;


-- ============================================================================
-- 3. Backfill — E-mail (notification_logs), mesma lógica, via charges.client_id
--    (notification_logs não tem client_id direto)
-- ============================================================================
insert into public.notification_logs (
  company_id, charge_id, channel, recipient, status, error_message, idempotency_key
)
select
  x.company_id,
  null,
  'email',
  null,
  'skipped',
  '[migração] Bloqueio preventivo — cliente já recebeu lembrete automático de e-mail hoje pelo sistema anterior.',
  'email-daily-reminder:' || x.company_id::text || ':' || x.client_id::text || ':'
    || to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD')
from (
  select distinct c.company_id, ch.client_id
  from public.notification_logs c
  join public.charges ch on ch.id = c.charge_id
  where c.channel = 'email'
    and c.idempotency_key like 'email-reminder:%'
    and c.status in ('sent', 'pending')
    and ch.client_id is not null
    and (coalesce(c.sent_at, c.created_at) at time zone 'America/Sao_Paulo')::date
        = (now() at time zone 'America/Sao_Paulo')::date
) x
on conflict (idempotency_key) do nothing;


-- ============================================================================
-- Verificação pós-backfill (apenas leitura)
-- ============================================================================
select count(*) as bloqueios_whatsapp_criados_hoje
from public.whatsapp_outbox
where message_type = 'daily_reminder'
  and error_message = 'Backfill de corte (cutover) — ver sql/backfill_daily_reminder_cutover_today.sql.';

select count(*) as bloqueios_email_criados_hoje
from public.notification_logs
where error_message = '[migração] Bloqueio preventivo — cliente já recebeu lembrete automático de e-mail hoje pelo sistema anterior.';
