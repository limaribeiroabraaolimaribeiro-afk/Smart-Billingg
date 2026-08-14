-- ============================================================================
-- Smart Billing — Migration: remover provider_transaction_id do recibo público
-- ----------------------------------------------------------------------------
-- Problema corrigido
-- -------------------
-- A função pública public.get_public_receipt_by_token(uuid) — chamada sem
-- login, via public_token, pela página recibo-publico.html — retornava a
-- coluna provider_transaction_id (código da transação do gateway de
-- pagamento). Esse dado não é necessário para o cliente final e não deveria
-- ser exposto a um usuário anônimo apenas de posse do link do recibo.
--
-- O que este script faz
-- ----------------------
-- Recria a função SEM a coluna provider_transaction_id no retorno. O código
-- da transação continua existindo normalmente na tabela public.payments,
-- disponível para o painel autenticado (RLS de payments/receipts não muda).
--
-- Por que DROP + CREATE (não apenas CREATE OR REPLACE)
-- ------------------------------------------------------
-- O PostgreSQL não permite alterar as colunas de retorno (RETURNS TABLE) de
-- uma função existente via CREATE OR REPLACE — é necessário derrubar a
-- função antes. Isso é seguro aqui: a função não tem estado, é apenas uma
-- consulta somente leitura, e os GRANTs são recriados na sequência.
--
-- Idempotente: pode ser executado mais de uma vez sem erro (DROP ... IF
-- EXISTS). Não apaga dados, não altera nenhuma tabela.
--
-- PRÉ-REQUISITO: sql/supabase_schema.sql já deve ter sido executado (este
-- script apenas substitui uma função que ele cria).
--
-- Como aplicar
-- ------------
-- Cole este arquivo inteiro no SQL Editor do seu projeto Supabase e clique
-- em Run. sql/supabase_schema.sql já foi atualizado com esta mesma definição
-- para instalações novas — este script separado é para bancos já em produção.
-- ============================================================================

drop function if exists public.get_public_receipt_by_token(uuid);

create function public.get_public_receipt_by_token(p_token uuid)
returns table (
  id                uuid,
  receipt_number    text,
  issued_at         timestamptz,
  charge_number     text,
  description       text,
  client_name       text,
  company_name      text,
  payment_method    public.payment_method_type,
  installments      integer,
  gross_amount      numeric,
  paid_at           timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    r.receipt_number,
    r.issued_at,
    c.charge_number,
    c.description,
    cl.name as client_name,
    co.name as company_name,
    p.payment_method,
    p.installments,
    p.gross_amount,
    p.paid_at
  from public.receipts r
  join public.charges c on c.id = r.charge_id
  join public.payments p on p.id = r.payment_id
  join public.companies co on co.id = r.company_id
  left join public.clients cl on cl.id = c.client_id
  where r.public_token = p_token;
$$;
comment on function public.get_public_receipt_by_token(uuid) is 'Retorna dados públicos e seguros de UM recibo via public_token, sem exigir login. Não inclui provider_transaction_id (uso interno apenas).';

grant execute on function public.get_public_receipt_by_token(uuid) to anon, authenticated;

-- ============================================================================
-- Verificação pós-migração (opcional, apenas leitura)
-- ----------------------------------------------------------------------------
-- Confirma que a coluna provider_transaction_id não está mais no retorno.
-- ============================================================================
select
  p.proname,
  pg_get_function_result(p.oid) as return_columns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_public_receipt_by_token';

-- Fim da migração.
