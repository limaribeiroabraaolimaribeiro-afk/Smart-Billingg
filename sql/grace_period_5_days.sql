-- Regra de tolerância do Smart Billing: sem multa/juros nos 5 dias corridos
-- após vencimento. Dia 6: multa única + juros simples apenas do dia 6 em diante.
-- Conserva snapshots de pagamentos concluídos e de revisões pendentes.

create or replace function public.calculate_late_charges(p_charge_id uuid)
returns table (
  original_amount        numeric,
  due_date                date,
  days_overdue            integer,
  late_fee_amount         numeric,
  late_interest_amount    numeric,
  updated_amount          numeric,
  calculation_date        date
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_charge  public.charges%rowtype;
  v_company public.companies%rowtype;
  v_days    integer;
  v_billable_days integer;
  v_today   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_grace_days constant integer := 5;
  v_fee     numeric(12, 2) := 0;
  v_interest numeric(12, 2) := 0;
  v_has_pending_review boolean;
begin
  select * into v_charge from public.charges where id = p_charge_id;
  if not found then
    raise exception 'Cobrança não encontrada';
  end if;

  select exists (
    select 1 from public.payment_reviews pr
    where pr.charge_id = p_charge_id and pr.status = 'pending_review'
  ) into v_has_pending_review;

  -- Pago/cancelado/com revisão pendente: devolve o snapshot já travado, nunca recalcula.
  if v_charge.status in ('paid', 'cancelled') or v_has_pending_review then
    return query select
      v_charge.amount,
      v_charge.due_date,
      greatest(0, coalesce(v_charge.late_fee_calculated_at::date, v_charge.due_date) - v_charge.due_date)::integer,
      coalesce(v_charge.late_fee_amount, 0),
      coalesce(v_charge.late_interest_amount, 0),
      coalesce(v_charge.updated_amount, v_charge.amount),
      coalesce((v_charge.late_fee_calculated_at at time zone 'America/Sao_Paulo')::date, v_today);
    return;
  end if;

  select * into v_company from public.companies where id = v_charge.company_id;

  v_days := greatest(0, (v_today - v_charge.due_date))::integer;
  v_billable_days := greatest(0, v_days - v_grace_days);

  -- Dias 1 a 5 após o vencimento: sem multa nem juros. Dia 6: primeiro dia de juros.
  if v_company.late_fee_enabled and v_billable_days > 0 then
    -- least(...,2.00) reforça o teto legal mesmo se a coluna tiver sido
    -- alterada por algum caminho que não passe pelo CHECK (defesa em camadas).
    v_fee := round(v_charge.amount * (least(v_company.late_fee_percent, 2.00) / 100), 2);
    v_interest := round(v_charge.amount * (v_company.late_interest_monthly_percent / 100) * (v_billable_days::numeric / 30), 2);
  end if;

  return query select
    v_charge.amount,
    v_charge.due_date,
    v_days,
    v_fee,
    v_interest,
    v_charge.amount + v_fee + v_interest,
    v_today;
end;
$$;
comment on function public.calculate_late_charges(uuid) is
  'Calcula multa e juros só a partir do 6º dia após vencimento (5 dias corridos sem encargos). Preserva o histórico de pago/cancelado/revisão.';


revoke all on function public.calculate_late_charges(uuid) from public, anon, authenticated;
grant execute on function public.calculate_late_charges(uuid) to service_role;
