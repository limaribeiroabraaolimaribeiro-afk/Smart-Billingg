-- ============================================================================
-- Smart Billing — Corrige duplicidade de lembrete automático (máx. 1/cliente/dia)
-- ----------------------------------------------------------------------------
-- BUG DE PRODUÇÃO: o worker estava enviando um WhatsApp automático POR
-- COBRANÇA elegível, não por cliente. Um cliente com 3 cobranças elegíveis
-- no mesmo dia (ex.: uma atrasada + uma vencendo hoje + uma vencendo em 3
-- dias) recebia 3 mensagens separadas. A idempotência existente
-- ("reminder:<charge_id>:<kind>") impedia repetir a MESMA cobrança/kind,
-- mas nunca impediu cobranças DIFERENTES do mesmo cliente no mesmo dia.
--
-- ESTE SCRIPT AINDA NÃO FOI EXECUTADO EM PRODUÇÃO. Revise antes de rodar no
-- SQL Editor do Supabase. Depois de sql/vps_worker_automation.sql (já
-- aplicada) — este arquivo assume que whatsapp_outbox, whatsapp_settings,
-- notification_logs, claim_whatsapp_jobs() e enqueue_whatsapp_message_system()
-- já existem.
--
-- Nova regra: NO MÁXIMO 1 lembrete automático de WhatsApp (e, separadamente,
-- 1 e-mail automático) POR CLIENTE POR DIA (America/Sao_Paulo) — vale
-- somente para due_soon_reminder/overdue_reminder automáticos; cobrança
-- nova, recibo, teste e mensagens manuais do painel continuam exatamente
-- como estavam, sem nenhum limite novo.
--
-- Se o cliente tiver várias cobranças elegíveis no mesmo dia, elas são
-- agrupadas em UMA mensagem consolidada (resumo) em vez de bloqueadas.
--
-- O que este script adiciona (nada é destruído, nada é removido)
-- ----------------------------------------------------------------------------
-- 1. whatsapp_message_type ganha o valor 'daily_reminder' (resumo
--    consolidado de um cliente, pode conter cobranças de kinds diferentes
--    misturados — por isso não usa mais due_soon_reminder/overdue_reminder
--    isoladamente para os lembretes automáticos).
-- 2. whatsapp_outbox.charge_ids uuid[] — array com TODAS as cobranças
--    incluídas num resumo diário (whatsapp_outbox.charge_id, a coluna
--    singular já existente, continua preenchida com a cobrança mais
--    urgente do resumo, só para compatibilidade com o histórico "por
--    cobrança" do painel — limitação conhecida: cobranças que não sejam a
--    mais urgente do resumo não aparecem no histórico individual delas).
-- 3. enqueue_daily_reminder_system() — nova função (service_role only) que
--    substitui, para lembretes automáticos, o uso de
--    enqueue_whatsapp_message_system() (que continua existindo, só não é
--    mais chamada por esse fluxo). A garantia de "no máximo 1 por cliente
--    por dia" está na CONSTRAINT ÚNICA já existente
--    (whatsapp_outbox.idempotency_key) — a chave agora é
--    "daily-reminder:<company_id>:<client_id>:<data local>", SEMPRE
--    calculada dentro da Edge Function (nunca aceita do worker), então nem
--    um worker com bug de fuso horário consegue furar essa proteção.
--    Também valida, na hora de inserir, que TODAS as cobranças do resumo
--    ainda pertencem ao cliente/empresa e continuam "pending" — se
--    qualquer uma não bater, rejeita o enfileiramento inteiro (nunca cria
--    um resumo parcialmente desatualizado).
-- 4. claim_whatsapp_jobs() — CREATE OR REPLACE (mesma assinatura, mesmo
--    comportamento para quem já chama) ganhando uma TERCEIRA higienização
--    (as duas anteriores — cancelar cobrança paga/cancelada/excluída e
--    reclamar "processing" travado — continuam intactas, sem nenhuma
--    remoção): cancela um resumo diário "pending" inteiro se QUALQUER
--    cobrança do seu charge_ids não estiver mais "pending" no momento do
--    envio — nunca envia um resumo com informação desatualizada.
-- ============================================================================


-- ============================================================================
-- 1. whatsapp_message_type.daily_reminder
-- ----------------------------------------------------------------------------
-- Fica isolado como o PRIMEIRO comando do script de propósito: em Postgres,
-- um valor de enum recém-adicionado só pode ser USADO (não apenas
-- referenciado em DDL) depois que o ALTER TYPE correspondente foi
-- efetivamente commitado. Rodando isso primeiro (e o restante do script
-- depois, na mesma janela do SQL Editor), o valor já está disponível
-- quando as funções abaixo forem criadas/chamadas.
-- ============================================================================
alter type public.whatsapp_message_type add value if not exists 'daily_reminder';


-- ============================================================================
-- 2. whatsapp_outbox.charge_ids
-- ============================================================================
alter table public.whatsapp_outbox
  add column if not exists charge_ids uuid[];

comment on column public.whatsapp_outbox.charge_ids is
  'Todas as cobranças incluídas num resumo diário (message_type = daily_reminder). charge_id (singular) continua preenchido com a cobrança mais urgente do resumo, só para compatibilidade com o histórico "por cobrança" do painel.';

create index if not exists idx_whatsapp_outbox_charge_ids on public.whatsapp_outbox using gin (charge_ids);


-- ============================================================================
-- 3. enqueue_daily_reminder_system — enfileiramento automático consolidado
-- ----------------------------------------------------------------------------
-- Restrita à service_role (só a Edge Function whatsapp-agent-api pode
-- chamar). Recebe SEMPRE um array de charge_ids (mesmo que tenha só 1) e
-- rejeita o enfileiramento inteiro se qualquer uma delas não pertencer ao
-- cliente/empresa informados ou não estiver mais "pending" neste exato
-- momento.
-- ============================================================================
create or replace function public.enqueue_daily_reminder_system(
  p_company_id       uuid,
  p_client_id        uuid,
  p_charge_ids       uuid[],
  p_message          text,
  p_idempotency_key  text
)
returns public.whatsapp_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient       text;
  v_primary_charge  uuid;
  v_valid_count     integer;
  v_row             public.whatsapp_outbox;
begin
  if p_charge_ids is null or array_length(p_charge_ids, 1) is null then
    raise exception 'charge_ids não pode ser vazio';
  end if;

  if p_message is null or length(trim(p_message)) = 0 or length(p_message) > 4096 then
    raise exception 'Mensagem inválida';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key é obrigatória para enfileiramento automático';
  end if;

  select whatsapp into v_recipient
  from public.clients
  where id = p_client_id and company_id = p_company_id;

  if v_recipient is null or length(trim(v_recipient)) = 0 then
    raise exception 'Cliente não encontrado nesta empresa, ou sem WhatsApp cadastrado';
  end if;

  -- Confirma que TODAS as cobranças do resumo pertencem a este cliente e
  -- empresa e ainda estão "pending" agora — se o total não bater, rejeita
  -- o enfileiramento inteiro em vez de criar um resumo parcial/desatualizado.
  select count(*) into v_valid_count
  from public.charges c
  where c.id = any(p_charge_ids)
    and c.company_id = p_company_id
    and c.client_id = p_client_id
    and c.status = 'pending';

  if v_valid_count <> array_length(p_charge_ids, 1) then
    raise exception 'Uma ou mais cobranças informadas não pertencem a este cliente, não estão pendentes, ou não existem';
  end if;

  -- p_charge_ids já vem ordenado por prioridade (mais urgente primeiro) —
  -- ver list_reminder_candidates na Edge Function. O primeiro elemento vira
  -- o charge_id "legado" (coluna singular, só para compatibilidade).
  v_primary_charge := p_charge_ids[1];

  insert into public.whatsapp_outbox (
    company_id, charge_id, charge_ids, client_id, recipient, message,
    message_type, status, idempotency_key
  ) values (
    p_company_id, v_primary_charge, p_charge_ids, p_client_id, v_recipient, p_message,
    'daily_reminder', 'pending', p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  -- idempotency_key já existia (outro ciclo/execução concorrente já
  -- enfileirou o lembrete deste cliente hoje): devolve a linha original em
  -- vez de erro — é exatamente a proteção "no máximo 1 por dia" funcionando.
  if v_row.id is null then
    select * into v_row from public.whatsapp_outbox where idempotency_key = p_idempotency_key;
  end if;

  return v_row;
end;
$$;
comment on function public.enqueue_daily_reminder_system(uuid, uuid, uuid[], text, text) is
  'Enfileira o resumo diário de lembrete automático de WhatsApp de um cliente (uso exclusivo do worker via service_role). No máximo 1 por cliente por dia, garantido pela constraint única de idempotency_key.';

revoke all on function public.enqueue_daily_reminder_system(uuid, uuid, uuid[], text, text) from public;
revoke all on function public.enqueue_daily_reminder_system(uuid, uuid, uuid[], text, text) from anon, authenticated;
grant execute on function public.enqueue_daily_reminder_system(uuid, uuid, uuid[], text, text) to service_role;


-- ============================================================================
-- 4. claim_whatsapp_jobs — adiciona a terceira higienização (resumos diários)
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE, mesma assinatura de sempre. As duas higienizações já
-- existentes (cancelar charge/due_soon_reminder/overdue_reminder cuja
-- cobrança não está mais pendente/existe; falhar "processing" travado há
-- mais de 5min) são preservadas EXATAMENTE como estavam — só foi
-- adicionada a terceira, para message_type = 'daily_reminder'.
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

  -- (a2) Mesma lógica para resumos diários (message_type = 'daily_reminder'):
  -- cancela o resumo INTEIRO se QUALQUER cobrança do array charge_ids não
  -- estiver mais "pending" (paga/cancelada/excluída) ou o array estiver
  -- vazio/nulo — nunca envia um resumo com informação desatualizada.
  update public.whatsapp_outbox o
  set status = 'cancelled',
      error_message = 'Uma ou mais cobranças do resumo diário não estão mais pendentes no momento do envio — mensagem cancelada automaticamente.',
      updated_at = now()
  where o.company_id = p_company_id
    and o.status = 'pending'
    and o.message_type = 'daily_reminder'
    and (
      o.charge_ids is null
      or array_length(o.charge_ids, 1) is null
      or exists (
        select 1 from unnest(o.charge_ids) as cid
        where not exists (select 1 from public.charges c where c.id = cid and c.status = 'pending')
      )
    );

  -- (b) Reivindica mensagens travadas em "processing" por mais de 5
  -- minutos (o worker foi encerrado/travou entre reivindicar e confirmar).
  -- NUNCA volta sozinha para "pending": não há como saber com certeza se o
  -- WhatsApp já entregou a mensagem antes do processo cair, então reenviar
  -- automaticamente arriscaria duplicidade. Fica em "failed", com o motivo
  -- explícito, para revisão manual.
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
  'Reivindica atomicamente até p_limit mensagens pendentes de uma empresa (FOR UPDATE SKIP LOCKED). Antes disso, cancela lembretes/resumos cuja(s) cobrança(s) não está(ão) mais pendente(s)/existe(m), e falha mensagens travadas em processing há mais de 5min. Uso exclusivo da service_role (Edge Function whatsapp-agent-api).';

revoke all on function public.claim_whatsapp_jobs(uuid, integer) from public;
revoke all on function public.claim_whatsapp_jobs(uuid, integer) from anon, authenticated;
grant execute on function public.claim_whatsapp_jobs(uuid, integer) to service_role;


-- ============================================================================
-- Verificação pós-migração (opcional, apenas leitura)
-- ============================================================================
select enumlabel from pg_enum
where enumtypid = 'public.whatsapp_message_type'::regtype
order by enumsortorder;
-- (deve incluir 'daily_reminder' na lista)

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'whatsapp_outbox' and column_name = 'charge_ids';

select proname, prosecdef
from pg_proc
where proname in ('enqueue_daily_reminder_system', 'claim_whatsapp_jobs');
