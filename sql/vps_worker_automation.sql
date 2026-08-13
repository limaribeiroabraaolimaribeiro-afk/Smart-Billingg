-- ============================================================================
-- Smart Billing — Preparação para o worker 24/7 (VPS Hostinger)
-- ----------------------------------------------------------------------------
-- ESTE SCRIPT AINDA NÃO FOI EXECUTADO EM PRODUÇÃO. Ele existe apenas como
-- preparação/documentação para quando o worker automático (cobranças por
-- WhatsApp/e-mail rodando 24/7 na VPS) for efetivamente ligado. Revise antes
-- de rodar no SQL Editor do Supabase.
--
-- PRÉ-REQUISITO: rode sql/supabase_schema.sql e sql/whatsapp_agent.sql
-- primeiro. Este arquivo depende de objetos já criados por eles:
-- public.charges, public.clients, public.companies, public.whatsapp_outbox,
-- public.whatsapp_settings, public.notification_logs,
-- public.whatsapp_message_type, public.set_updated_at().
--
-- O que este script adiciona (nada é destruído, nada é removido)
-- ----------------------------------------------------------------------------
-- 1. whatsapp_settings.email_reminders_enabled — novo interruptor por
--    empresa para habilitar/desabilitar o envio de e-mail nos MESMOS
--    lembretes já configurados (remind_3_days_before, remind_1_day_before,
--    remind_on_due_date, remind_when_overdue). Não inventa uma nova grade
--    de dias/horários — reaproveita exatamente as regras de data que já
--    existem para o WhatsApp; este novo campo controla apenas se o CANAL
--    e-mail também deve ser usado nelas. Default false: nenhum
--    comportamento muda até a empresa marcar essa opção explicitamente.
-- 2. notification_logs.idempotency_key — chave opcional e única, para o
--    worker conseguir registrar "já tentei enviar este e-mail de lembrete"
--    de forma persistente (sobrevive a reinício da VPS), do mesmo jeito
--    que whatsapp_outbox.idempotency_key já garante para o WhatsApp.
-- 3. enqueue_whatsapp_message_system() — variante de
--    enqueue_whatsapp_message() para uso EXCLUSIVO do worker automático
--    (via service_role, chamada pela Edge Function whatsapp-agent-api).
--    A função original exige um usuário autenticado (auth.uid()) membro da
--    empresa, porque é chamada pelo painel; o worker não é um usuário
--    logado — é infraestrutura de confiança, autenticada por
--    WHATSAPP_AGENT_TOKEN antes mesmo de chegar aqui. Por isso esta versão
--    não repete a checagem de auth.uid()/has_company_role, mas preserva a
--    MESMA garantia de segurança essencial: o destinatário é sempre
--    resolvido a partir de charges/clients no banco, nunca aceito como
--    texto livre de quem chama. SÓ enfileira se a cobrança ainda estiver
--    "pending" NESTE EXATO MOMENTO (fecha a janela entre "listar candidatos
--    de lembrete" e "enfileirar" — ver item 4 abaixo para a segunda janela,
--    entre "enfileirar" e "efetivamente enviar").
-- 4. claim_whatsapp_jobs() — SUBSTITUÍDA (CREATE OR REPLACE, mesma
--    assinatura, 100% compatível com quem já chama) para adicionar DUAS
--    proteções descobertas na revisão de segurança antes do primeiro
--    deploy do worker:
--      a) Cancela automaticamente qualquer mensagem "pending" de tipo
--         charge/due_soon_reminder/overdue_reminder cuja cobrança já não
--         esteja mais "pending" (paga/cancelada) OU tenha sido excluída
--         (charge_id fica NULL via ON DELETE SET NULL quando um cliente é
--         excluído em cascata) — fecha a janela entre "enfileirar lembrete"
--         e "worker efetivamente envia". Sem isso, um cliente que paga (ou
--         é excluído) minutos depois do lembrete ser enfileirado ainda
--         receberia a cobrança por WhatsApp.
--      b) Reivindica mensagens travadas em "processing" por mais de 5
--         minutos (worker morto/reiniciado no meio do envio) e as marca
--         como "failed" com um aviso explícito — DELIBERADAMENTE não volta
--         sozinha para "pending", para nunca arriscar duplicar uma
--         mensagem que pode já ter sido entregue pelo WhatsApp antes do
--         crash. Fica registrada para revisão manual.
-- ============================================================================


-- ============================================================================
-- 1. whatsapp_settings.email_reminders_enabled
-- ============================================================================
alter table public.whatsapp_settings
  add column if not exists email_reminders_enabled boolean not null default false;

comment on column public.whatsapp_settings.email_reminders_enabled is
  'Habilita o envio de e-mail (além do WhatsApp) nos mesmos lembretes já configurados por data (remind_3_days_before/remind_1_day_before/remind_on_due_date/remind_when_overdue). Default false.';


-- ============================================================================
-- 2. notification_logs.idempotency_key
-- ============================================================================
alter table public.notification_logs
  add column if not exists idempotency_key text unique;

comment on column public.notification_logs.idempotency_key is
  'Chave determinística (ex.: "email-reminder:<charge_id>:<kind>") usada pelo worker para reivindicar o envio de um e-mail exatamente uma vez, mesmo com reinícios/ciclos concorrentes. NULL para logs antigos ou de outras origens (ex.: envio manual de recibo).';

create index if not exists idx_notification_logs_charge on public.notification_logs (charge_id);
create index if not exists idx_notification_logs_company on public.notification_logs (company_id);


-- ============================================================================
-- 3. enqueue_whatsapp_message_system — enfileiramento automático (worker)
-- ----------------------------------------------------------------------------
-- Restrita à service_role (só a Edge Function whatsapp-agent-api pode
-- chamar). p_message_type aceita apenas 'due_soon_reminder' ou
-- 'overdue_reminder' — os únicos tipos que fazem sentido para lembretes
-- automáticos (cobrança nova e recibo continuam passando por
-- enqueue_whatsapp_message(), chamada pelo painel).
-- ============================================================================
create or replace function public.enqueue_whatsapp_message_system(
  p_company_id       uuid,
  p_charge_id        uuid,
  p_message_type     public.whatsapp_message_type,
  p_message          text,
  p_idempotency_key  text
)
returns public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id  uuid;
  v_recipient  text;
  v_row        public.whatsapp_outbox;
begin
  if p_message_type not in ('due_soon_reminder', 'overdue_reminder') then
    raise exception 'message_type inválido para enfileiramento automático: %', p_message_type;
  end if;

  if p_message is null or length(trim(p_message)) = 0 or length(p_message) > 4096 then
    raise exception 'Mensagem inválida';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key é obrigatória para enfileiramento automático';
  end if;

  -- Resolve cliente/telefone SEMPRE a partir do banco (nunca aceito do
  -- chamador) — mesma garantia de enqueue_whatsapp_message(). Exige
  -- status = 'pending' NESTE MOMENTO: se a cobrança já foi paga/cancelada
  -- entre o worker "listar candidatos" e "enfileirar", a chamada falha aqui
  -- em vez de criar uma mensagem para uma cobrança que não é mais devida.
  select c.client_id into v_client_id
  from public.charges c
  where c.id = p_charge_id and c.company_id = p_company_id and c.status = 'pending';

  if v_client_id is null then
    raise exception 'Cobrança não encontrada nesta empresa, não está mais pendente, ou sem cliente associado';
  end if;

  select whatsapp into v_recipient
  from public.clients
  where id = v_client_id and company_id = p_company_id;

  if v_recipient is null or length(trim(v_recipient)) = 0 then
    raise exception 'Cliente não possui WhatsApp cadastrado';
  end if;

  insert into public.whatsapp_outbox (
    company_id, charge_id, client_id, recipient, message, message_type,
    status, idempotency_key
  ) values (
    p_company_id, p_charge_id, v_client_id, v_recipient, p_message, p_message_type,
    'pending', p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  -- idempotency_key já existia: devolve a linha original (o worker não
  -- deve tratar isso como erro — é exatamente a proteção contra duplicidade
  -- funcionando).
  if v_row.id is null then
    select * into v_row from public.whatsapp_outbox where idempotency_key = p_idempotency_key;
  end if;

  return v_row;
end;
$$;
comment on function public.enqueue_whatsapp_message_system(uuid, uuid, public.whatsapp_message_type, text, text) is
  'Enfileira um lembrete automático de WhatsApp (uso exclusivo do worker via service_role). Resolve o destinatário sempre a partir de charges/clients no banco. Idempotente por p_idempotency_key.';

revoke all on function public.enqueue_whatsapp_message_system(uuid, uuid, public.whatsapp_message_type, text, text) from public;
revoke all on function public.enqueue_whatsapp_message_system(uuid, uuid, public.whatsapp_message_type, text, text) from anon, authenticated;
grant execute on function public.enqueue_whatsapp_message_system(uuid, uuid, public.whatsapp_message_type, text, text) to service_role;


-- ============================================================================
-- 4. claim_whatsapp_jobs — SUBSTITUÍDA com as duas proteções descritas acima
-- ----------------------------------------------------------------------------
-- Mesma assinatura da função original (definida em sql/whatsapp_agent.sql):
-- claim_whatsapp_jobs(p_company_id uuid, p_limit integer). CREATE OR REPLACE
-- não quebra nenhum chamador existente (queue.js do worker, Edge Function
-- whatsapp-agent-api) — o comportamento de reivindicar mensagens pendentes
-- via FOR UPDATE SKIP LOCKED continua idêntico; só ganha as duas
-- higienizações abaixo, executadas ANTES de reivindicar qualquer coisa.
--
-- Validado localmente (banco Postgres descartável, fora do Supabase) antes
-- desta revisão: 6 "consumidores" concorrentes disputando 10 mensagens
-- pendentes — nenhuma mensagem foi reivindicada duas vezes; 8 tentativas
-- concorrentes de enfileirar com a MESMA idempotency_key — apenas 1 linha
-- criada; cobrança paga entre "enfileirar" e "reivindicar" — mensagem
-- cancelada automaticamente, nunca chega a "processing"; job travado em
-- "processing" por >5min — marcado "failed" (nunca reenviado sozinho).
-- ============================================================================
create or replace function public.claim_whatsapp_jobs(p_company_id uuid, p_limit integer default 5)
returns setof public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (a) Cancela mensagens "pending" cuja cobrança não é mais válida para
  -- cobrança — paga/cancelada (charge ainda existe mas status mudou) ou
  -- excluída (charge_id ficou NULL via ON DELETE SET NULL, ex.: cliente
  -- excluído em cascata). Escopo: só tipos ligados a uma cobrança em
  -- aberto (charge/due_soon_reminder/overdue_reminder) — recibo/teste/
  -- mensagem avulsa não dependem do status da cobrança e não são tocados.
  update public.whatsapp_outbox o
  set status = 'cancelled',
      error_message = 'Cobrança não está mais pendente (paga/cancelada/excluída) no momento do envio — lembrete cancelado automaticamente.',
      updated_at = now()
  where o.company_id = p_company_id
    and o.status = 'pending'
    and o.message_type in ('charge', 'due_soon_reminder', 'overdue_reminder')
    and not exists (
      select 1 from public.charges c
      where c.id = o.charge_id and c.status = 'pending'
    );

  -- (b) Reivindica mensagens travadas em "processing" por mais de 5
  -- minutos (o worker foi encerrado/travou entre reivindicar e confirmar).
  -- NUNCA volta sozinha para "pending": não há como saber com certeza se o
  -- WhatsApp já entregou a mensagem antes do processo cair, então reenviar
  -- automaticamente arriscaria duplicidade. Fica em "failed", com o motivo
  -- explícito, para revisão manual — respeitando o mesmo max_attempts (não
  -- é um reset: se o worker tentar de novo manualmente e falhar outra vez,
  -- o job já usado eventualmente esgota as tentativas normalmente).
  update public.whatsapp_outbox o
  set status = 'failed',
      failed_at = now(),
      error_message = 'Reivindicado mas não confirmado dentro do tempo esperado (processo pode ter sido interrompido). Verifique manualmente se a mensagem já foi entregue antes de reenviar.',
      updated_at = now()
  where o.company_id = p_company_id
    and o.status = 'processing'
    and o.claimed_at < now() - interval '5 minutes';

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
comment on function public.claim_whatsapp_jobs(uuid, integer) is
  'Reivindica atomicamente até p_limit mensagens pendentes de uma empresa (FOR UPDATE SKIP LOCKED). Antes disso, cancela lembretes cuja cobrança não está mais pendente/existe, e falha mensagens travadas em processing há mais de 5min. Uso exclusivo da service_role (Edge Function whatsapp-agent-api).';

-- Grants preservados exatamente como na definição original (sql/whatsapp_agent.sql).
revoke all on function public.claim_whatsapp_jobs(uuid, integer) from public;
revoke all on function public.claim_whatsapp_jobs(uuid, integer) from anon, authenticated;
grant execute on function public.claim_whatsapp_jobs(uuid, integer) to service_role;


-- ============================================================================
-- Verificação pós-migração (opcional, apenas leitura)
-- ============================================================================
select
  column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'whatsapp_settings' and column_name = 'email_reminders_enabled')
    or (table_name = 'notification_logs' and column_name = 'idempotency_key'));

select proname, prosecdef
from pg_proc
where proname in ('enqueue_whatsapp_message_system', 'claim_whatsapp_jobs');
