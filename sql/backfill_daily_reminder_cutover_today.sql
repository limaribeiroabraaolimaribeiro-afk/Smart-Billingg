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
-- e reiniciar o worker), alguns clientes já podem ter RECEBIDO, ou ter
-- AINDA NA FILA/EM ENVIO, 1, 2 ou 3 lembretes automáticos hoje.
--
-- O novo sistema usa uma chave por CLIENTE/DIA
-- ("daily-reminder:<company_id>:<client_id>:<data local>"), que é
-- COMPLETAMENTE DIFERENTE da chave antiga. Sem este backfill, na primeira
-- vez que o worker novo rodar hoje, ele NÃO reconhece os lembretes antigos
-- já enviados — a chave nova nunca existiu, então o INSERT ... ON CONFLICT
-- não teria nada para colidir, e o cliente receberia uma mensagem extra
-- (o resumo consolidado) no mesmo dia.
--
-- VERSÃO ANTERIOR DESTE SCRIPT TINHA UMA LACUNA: ela criava o "placeholder"
-- que bloqueia o resumo novo, mas nunca tocava nos jobs antigos que ainda
-- estavam 'pending'/'processing' em whatsapp_outbox. Esses jobs continuam
-- existindo independente do placeholder — e claim_whatsapp_jobs() (chamada
-- pelo worker novo, no ciclo seguinte, via queue.js) reivindica QUALQUER
-- job 'pending' da fila, sem saber se ele é "legado" ou novo. Resultado:
-- mesmo com o placeholder, um cliente com 1 sent + 2 pending antigos hoje
-- ainda tomaria 2 mensagens extras depois do restart — o placeholder só
-- impedia uma 3ª/4ª mensagem NOVA, não as antigas já na fila. Esta versão
-- corrige isso processando também os jobs antigos, não só criando o
-- placeholder.
--
-- REGRA APLICADA (por cliente, considerando só due_soon_reminder/
-- overdue_reminder automáticos — created_by IS NULL — de HOJE):
-- ----------------------------------------------------------------------------
-- 1. Cliente com pelo menos 1 lembrete 'sent' hoje:
--    → cria o placeholder 'daily_reminder' de hoje (bloqueia o resumo novo);
--    → cancela (status='cancelled') todos os outros jobs 'pending' do mesmo
--      cliente hoje — nunca mais podem ser enviados por claim_whatsapp_jobs.
-- 2. Cliente com job 'processing' hoje (com ou sem 'sent' junto):
--    → trata como potencialmente já entregue (não há como saber com certeza
--      se o WhatsApp confirmou antes do worker antigo ser encerrado);
--    → cria o placeholder 'daily_reminder' de hoje (mesma proteção do
--      item 1 — nunca cria um resumo novo para esse cliente hoje);
--    → o job 'processing' em si vai para 'failed' IMEDIATAMENTE (não espera
--      os 5 minutos da reivindicação de "processing travado" que
--      claim_whatsapp_jobs() já faz sozinha) — garante que ele nunca volta
--      a 'pending' nem é reenviado automaticamente, com o motivo registrado
--      no histórico (error_message), deixando explícito que a entrega é
--      incerta, para conferência manual se necessário.
-- 3. Cliente SEM nenhum 'sent'/'processing' hoje, só com jobs 'pending'
--    antigos (nunca chegou a ser processado pelo sistema antigo):
--    → cancela os 'pending' antigos (mesmo motivo do item 1);
--    → NÃO cria placeholder — assim, no primeiro ciclo do worker novo, ele
--      poderá enfileirar exatamente 1 resumo diário consolidado normal para
--      esse cliente (as cobranças em si nunca são tocadas por este script,
--      só os jobs de mensagem — list_reminder_candidates/
--      enqueue_daily_reminder_system continuam funcionando exatamente como
--      sempre para essas cobranças ainda pendentes).
-- 4. Mensagens com status 'cancelled' ou 'failed' de hoje (antes de rodar
--    este script) NÃO contam para nada acima — não houve entrega nem nada
--    em andamento, então não fazem um cliente ser tratado como "já
--    alcançado hoje".
-- 5. Mensagens manuais (created_by IS NOT NULL — o painel permite disparar
--    manualmente um lembrete com o mesmo message_type) NUNCA entram em
--    nenhuma das contas/ações acima — só jobs 100% automáticos
--    (created_by IS NULL) são considerados ou tocados.
-- 6. Cobrança nova (charge), recibo (receipt), teste (test) e mensagem
--    avulsa (custom) NUNCA são tocados por este script, em nenhum status —
--    só due_soon_reminder/overdue_reminder automáticos, exatamente como
--    pedido.
--
-- Cobre WhatsApp (whatsapp_outbox) e, pela mesma lógica de "já alcançado
-- hoje" (sem a parte de jobs pendentes/processing, que não existe para
-- e-mail — ver nota na seção 5), e-mail (notification_logs).
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
--    específico — é idempotente, seguro rodar mais de uma vez (rodar 2x no
--    mesmo dia não cancela/altera nada que já tenha sido cancelado/falhado
--    pela rodada anterior, e o placeholder usa ON CONFLICT DO NOTHING).
-- ============================================================================


-- ============================================================================
-- 1. Pré-visualização — quantos clientes seriam afetados, e qual ação cada
--    um receberia (rode isso primeiro para conferir antes de decidir aplicar)
-- ============================================================================
select
  o.company_id,
  o.client_id,
  count(*) filter (where o.status = 'sent')       as sent_hoje,
  count(*) filter (where o.status = 'processing') as processing_hoje,
  count(*) filter (where o.status = 'pending')     as pending_hoje,
  case
    when bool_or(o.status in ('sent', 'processing'))
      then 'cria placeholder + cancela pending antigos (+ falha processing antigo)'
    else 'so cancela pending antigos, sem placeholder (resumo novo sera criado normalmente)'
  end as acao_do_backfill
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
-- 2. Placeholder — WhatsApp (whatsapp_outbox), só para clientes com 'sent'
--    e/ou 'processing' automático hoje (regras 1 e 2). Roda ANTES das
--    seções 3/4 de propósito: a condição abaixo (status IN ('sent',
--    'processing')) precisa enxergar os jobs 'processing' ANTES da seção 3
--    convertê-los para 'failed' — se rodasse depois, um cliente que só
--    tivesse 'processing' (sem 'sent') deixaria de ser detectado.
-- ============================================================================
insert into public.whatsapp_outbox (
  company_id, client_id, recipient, message, message_type, status,
  idempotency_key, error_message
)
select
  o.company_id,
  o.client_id,
  cl.whatsapp,
  '[migração] Bloqueio preventivo — cliente já recebeu (ou estava recebendo) lembrete(s) automático(s) de WhatsApp hoje pelo sistema anterior.',
  'daily_reminder',
  'cancelled',
  'daily-reminder:' || o.company_id::text || ':' || o.client_id::text || ':'
    || to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
  'Backfill de corte (cutover) — ver sql/backfill_daily_reminder_cutover_today.sql.'
from (
  select distinct o.company_id, o.client_id
  from public.whatsapp_outbox o
  where o.message_type in ('due_soon_reminder', 'overdue_reminder')
    and o.status in ('sent', 'processing')
    and o.client_id is not null
    and o.created_by is null
    and (coalesce(o.sent_at, o.created_at) at time zone 'America/Sao_Paulo')::date
        = (now() at time zone 'America/Sao_Paulo')::date
) o
join public.clients cl on cl.id = o.client_id
on conflict (idempotency_key) do nothing;


-- ============================================================================
-- 3. Resolve jobs 'processing' antigos travados pelo corte (regra 2) —
--    IMEDIATAMENTE, sem esperar os 5 minutos que claim_whatsapp_jobs() usa
--    para reivindicar "processing" travado sozinha. Nunca volta a
--    'pending'; fica em 'failed' com o motivo explícito, preservando o
--    histórico e deixando claro que a entrega é incerta (o processo antigo
--    que reivindicou este job foi encerrado pelo restart antes de
--    confirmar se o WhatsApp entregou ou não).
-- ============================================================================
update public.whatsapp_outbox o
set status = 'failed',
    failed_at = now(),
    error_message = '[migração] Job automático reivindicado pelo sistema anterior antes do corte (cutover) — entrega incerta (processo encerrado pelo restart antes de confirmar). Nunca reenviado automaticamente; verifique manualmente se necessário. Ver sql/backfill_daily_reminder_cutover_today.sql.',
    updated_at = now()
where o.message_type in ('due_soon_reminder', 'overdue_reminder')
  and o.status = 'processing'
  and o.client_id is not null
  and o.created_by is null
  and (coalesce(o.sent_at, o.created_at) at time zone 'America/Sao_Paulo')::date
      = (now() at time zone 'America/Sao_Paulo')::date;


-- ============================================================================
-- 4. Cancela jobs 'pending' antigos (regras 1 e 3) — para QUALQUER cliente
--    do universo automático de hoje, tenha ele ganhado o placeholder da
--    seção 2 ou não. Isto fecha a lacuna real: sem isto, claim_whatsapp_jobs()
--    reivindicaria esses jobs 'pending' antigos no primeiro ciclo do worker
--    novo e queue.js os enviaria, ignorando completamente o placeholder
--    (que só bloqueia a CRIAÇÃO de um resumo novo, não jobs antigos já na
--    fila).
-- ============================================================================
update public.whatsapp_outbox o
set status = 'cancelled',
    error_message = '[migração] Lembrete automático legado cancelado no corte (cutover) para respeitar o limite de 1 mensagem automática por cliente/dia. Ver sql/backfill_daily_reminder_cutover_today.sql.',
    updated_at = now()
where o.message_type in ('due_soon_reminder', 'overdue_reminder')
  and o.status = 'pending'
  and o.client_id is not null
  and o.created_by is null
  and (coalesce(o.sent_at, o.created_at) at time zone 'America/Sao_Paulo')::date
      = (now() at time zone 'America/Sao_Paulo')::date;


-- ============================================================================
-- 5. Backfill — E-mail (notification_logs), mesma lógica de "já alcançado
--    hoje" (regras 1/2), via charges.client_id (notification_logs não tem
--    client_id direto). Sem seção de 'pending'/'processing' antigos aqui de
--    propósito: e-mail não passa por uma fila/worker separado como o
--    WhatsApp — o envio é síncrono dentro da própria chamada da Edge
--    Function (upsert 'pending' → chama Resend → update 'sent'/'failed' na
--    mesma execução), sem nenhum processo que reivindique e reenvie um
--    'pending' travado depois. Um e-mail preso em 'pending' hoje (só
--    aconteceria se a Edge Function caísse no meio do envio) já não seria
--    reenviado por nada — não há risco de duplicidade equivalente ao do
--    WhatsApp aqui, então não há necessidade de cancelar nada, só o
--    bloqueio preventivo do resumo novo já cobre o caso.
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

select count(*) as jobs_processing_marcados_failed_hoje
from public.whatsapp_outbox
where status = 'failed'
  and error_message like '[migração] Job automático reivindicado pelo sistema anterior%';

select count(*) as jobs_pending_cancelados_hoje
from public.whatsapp_outbox
where status = 'cancelled'
  and error_message like '[migração] Lembrete automático legado cancelado no corte%';

select count(*) as bloqueios_email_criados_hoje
from public.notification_logs
where error_message = '[migração] Bloqueio preventivo — cliente já recebeu lembrete automático de e-mail hoje pelo sistema anterior.';
