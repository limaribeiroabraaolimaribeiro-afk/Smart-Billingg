
-- Uma parcela por cobrança do Smart Billing. Preserva a data do contrato original
-- e registra separadamente a concessão operacional de tolerância.
create table if not exists public.sale_contract_installments (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.sale_contracts(id) on delete restrict,
  charge_id uuid not null unique references public.charges(id) on delete restrict,
  installment_number smallint not null check (installment_number between 1 and 10),
  contract_due_date date not null,
  collection_due_date date not null,
  grace_reason text,
  created_at timestamptz not null default now(),
  unique(contract_id, installment_number)
);
alter table public.sale_contract_installments enable row level security;
revoke all on public.sale_contract_installments from anon, authenticated;
create index if not exists sale_contract_installments_contract_index on public.sale_contract_installments(contract_id,installment_number);

DO $setup$
DECLARE
  v_contract public.sale_contracts%ROWTYPE;
  v_client uuid;
  v_charge uuid;
  v_original_due date;
  v_collection_due date;
  v_i integer;
BEGIN
  SELECT * INTO v_contract FROM public.sale_contracts
  WHERE id='ea6885d8-9f11-415f-80d5-85156625d1f4'
  FOR UPDATE;

  IF NOT FOUND OR v_contract.status <> 'signed' THEN
    RAISE EXCEPTION 'Contrato ausente ou nao assinado';
  END IF;
  IF v_contract.first_due_date <> '2026-11-06' OR v_contract.total_cents <> 185000 THEN
    RAISE EXCEPTION 'Data ou valor diverge do contrato original';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sale_contract_installments WHERE contract_id=v_contract.id) THEN
    RAISE EXCEPTION 'Parcelas ja foram criadas para esse contrato';
  END IF;
  -- Não cadastrar duplicado se a cliente já estiver associada à mesma empresa.
  SELECT id INTO v_client FROM public.clients
  WHERE company_id=v_contract.company_id
    AND regexp_replace(coalesce(document,''),'\D','','g')=v_contract.buyer_cpf
  LIMIT 1 FOR UPDATE;
  IF v_client IS NULL THEN
    INSERT INTO public.clients(company_id,name,email,whatsapp,document,notes)
    VALUES (v_contract.company_id,v_contract.buyer_name,v_contract.buyer_email,
            v_contract.buyer_phone,v_contract.buyer_cpf,
            'Compradora do notebook ASUS VivoBook - contrato assinado')
    RETURNING id INTO v_client;
  END IF;

  FOR v_i IN 1..10 LOOP
    v_original_due := (date_trunc('month',v_contract.first_due_date)::date + make_interval(months => v_i-1))::date
      + (extract(day from v_contract.first_due_date)::integer - 1);
    v_collection_due := CASE WHEN v_i=1 THEN date '2026-11-07' ELSE v_original_due END;
    INSERT INTO public.charges(company_id,client_id,description,amount,due_date,status,
      payment_methods,max_installments,notes,created_by,provider)
    VALUES(v_contract.company_id,v_client,
      'Notebook ASUS VivoBook Core i3 - parcela '||lpad(v_i::text,2,'0')||'/10',
      185.00,v_collection_due,'pending','["pix"]'::jsonb,1,
      CASE WHEN v_i=1 THEN
        'Contrato assinado: vencimento original 06/11/2026. Vendedor concedeu tolerancia ate 07/11/2026, sem multa ou juros nesse dia. Nao indica pagamento.'
      ELSE 'Parcela '||v_i||'/10 vinculada ao contrato de venda particular; vencimento contratual no dia 6.' END,
      v_contract.created_by,'infinitepay')
    RETURNING id INTO v_charge;
    INSERT INTO public.sale_contract_installments(
      contract_id,charge_id,installment_number,contract_due_date,collection_due_date,grace_reason
    ) VALUES(
      v_contract.id,v_charge,v_i,v_original_due,v_collection_due,
      CASE WHEN v_i=1 THEN 'Tolerancia de 1 dia concedida pelo vendedor em 07/11/2026, sem encargos no dia' ELSE NULL END
    );
  END LOOP;
END
$setup$;
