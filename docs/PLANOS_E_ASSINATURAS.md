# Planos, Ofertas e Assinaturas

Camada de planos comerciais construída **sobre** o sistema de cobranças já existente do Smart Billing — não é um sistema de pagamento paralelo. Um plano escolhido sempre vira uma cobrança normal na tabela `charges`, que segue exatamente o mesmo fluxo de sempre (checkout InfinitePay → webhook → `payments`/`receipts`).

```
PLANO → OFERTA → COBRANÇA NORMAL → INFINITEPAY → WEBHOOK → PAGAMENTO → RECIBO → ASSINATURA
```

## Arquitetura

### Banco de dados (`sql/billing_plans.sql`)

Três tabelas novas, todas com `company_id` e RLS seguindo o mesmo padrão de `is_company_member`/`has_company_role` já usado no resto do projeto:

- **`billing_plans`** — planos comerciais (nome, preço, preço de referência, desconto, duração em meses, tipo de cobrança, badge, destaque, formas de pagamento, parcelas máximas, ativo/inativo).
- **`plan_offers`** — oferta de um conjunto de planos a um cliente específico, com `public_token` (UUID aleatório, imprevisível) e `expires_at`. Status armazenado: `active` / `selected` / `cancelled` — **não existe** um status `expired` armazenado; uma oferta "expirada" é `status='active'` com `expires_at` no passado, seguindo o mesmo padrão já usado por `charges.status` (que também nunca grava `overdue` — é sempre computado comparando datas). O comportamento observável é idêntico ao pedido; só a forma de armazenamento segue o precedente já estabelecido no projeto.
- **`client_subscriptions`** — assinatura de um cliente a um plano. Status: `pending` / `active` / `overdue` / `cancelled` / `expired` (aqui sim, armazenado — é estado operacional real, gerenciado pela rotina de renovação, não derivável só de uma data).

`charges` ganhou 3 colunas opcionais, todas aceitando `NULL` (retrocompatibilidade total com cobranças antigas): `plan_id`, `offer_id`, `subscription_id`. Também ganhou `renewal_period date` (só preenchida em cobranças de renovação mensal — ver seção Renovação).

### Segurança do link público

A página `oferta.html` nunca lê tabelas diretamente. Todo acesso passa por:

- `get_public_plan_offer_by_token(p_token uuid)` — `security definer`, `grant` só para `anon`/`authenticated`, retorna apenas os campos necessários para renderizar a página (nunca `company_id`/`client_id` internos). Calcula `is_expired` no próprio banco.
- `select_plan_offer(p_offer_token uuid, p_plan_id uuid)` — restrita a `service_role`, chamada só pela Edge Function pública `select-plan-offer`. Recebe **apenas** o token da oferta e o id do plano escolhido; busca preço/duração/parcelas sempre em `billing_plans`, nunca aceita esses valores do chamador.

### Concorrência e idempotência (clique duplo)

`select_plan_offer()` reivindica a oferta com um único `UPDATE ... WHERE status = 'active' RETURNING`, protegido por `SELECT ... FOR UPDATE` na mesma transação. Sob concorrência real do Postgres, a segunda transação só executa depois que a primeira comita — e nesse momento o `WHERE status = 'active'` já não casa mais, então ela recebe `already_selected` com os dados da cobrança já criada, em vez de criar uma segunda. **Testado empiricamente** com múltiplas sessões `psql` verdadeiramente concorrentes (não simulado) — ver seção Testes.

A cobrança só é criada **depois** que o claim da oferta é confirmado — nunca antes.

### Ativação da assinatura

A assinatura só vira `active` depois que o pagamento é **confirmado** por um caminho já confiável:

- `register_infinitepay_payment()` (chamada pelo webhook `infinitepay-webhook` e por `check-infinitepay-payment`) — estendida via `CREATE OR REPLACE` (mesma assinatura) para chamar `activate_subscription_on_charge_paid(charge_id)` logo após marcar a cobrança como paga. **Nenhum código das Edge Functions precisou mudar** — elas continuam chamando a mesma RPC de sempre.
- `register_manual_payment()` (reconciliação manual pelo painel) — mesma extensão, para consistência.

Clicar em "Escolher plano" **nunca** ativa a assinatura — só cria a cobrança em `pending`.

**Cálculo de validade:**

| Plano | Ao confirmar pagamento |
|---|---|
| Anual (`one_time`, `duration_months=12`) | `starts_at = agora`, `ends_at = starts_at + 12 meses`, `next_billing_at = null` |
| 2 anos (`one_time`, `duration_months=24`) | `starts_at = agora`, `ends_at = starts_at + 24 meses`, `next_billing_at = null` |
| Mensal (`recurring_monthly`, `duration_months=1`) | `starts_at = agora`, `ends_at = null`, `next_billing_at = starts_at + 1 mês` |

Para renovações (cobrança que não é a inicial da assinatura), `next_billing_at` avança a partir do **valor anterior** de `next_billing_at` (âncora preservada — ex.: sempre dia 28), nunca a partir de "agora" — evita deriva de data quando um pagamento é confirmado com atraso.

## Renovação mensal

A InfinitePay, nesta integração, **não tem cobrança recorrente automática confirmada** — o endpoint usado (`POST /links`, ver `supabase/functions/_shared/infinitepay.ts`) gera um link de pagamento avulso por chamada, sem parâmetro de recorrência documentado. Por isso o Smart Billing controla a recorrência mensal sozinho, reaproveitando 100% da infraestrutura do worker que já existe (o mesmo processo Node que já faz polling de lembretes):

1. `smart-billing-agent/src/subscriptions.js` (`runRenewalCycle()`), chamado a cada ciclo do scheduler existente (`smart-billing-agent/src/scheduler.js`), junto com o ciclo de lembretes.
2. Chama a ação `list_due_subscription_renewals` da Edge Function `whatsapp-agent-api` — lista assinaturas `recurring_monthly` com `next_billing_at` vencido e sem cobrança ainda para o ciclo.
3. Para cada uma, chama `create_subscription_renewal_charge` — que executa a RPC `create_subscription_renewal_charge(subscription_id)` (idempotente por `(subscription_id, renewal_period)` via `unique index`, com fallback de `ON CONFLICT DO NOTHING` + `SELECT` da linha existente), gera o checkout InfinitePay (mesma lógica de `create-infinitepay-checkout`, via `_shared/infinitepay.ts`) e enfileira o aviso de WhatsApp na fila já existente (`whatsapp_outbox`, mesmo `queue.js`/worker que já processa tudo).

**Idempotência testada sob concorrência real**: 5 chamadas `psql` verdadeiramente simultâneas para a mesma assinatura vencida resultaram em exatamente 1 cobrança de renovação (ver seção Testes) — reiniciar a VPS, rodar dois processos do worker por engano, ou o scheduler disparar duas vezes seguidas nunca duplica uma renovação.

## Limitação da InfinitePay — parcelamento

O checkout InfinitePay (`POST /links`) **não recebe** nenhum parâmetro de limite de parcelas — confirmado lendo o código já existente: `create-infinitepay-checkout/index.ts` seleciona `charges.max_installments` do banco mas nunca o envia no `linkPayload`; o parcelamento real é decidido inteiramente pela própria InfinitePay na página de checkout hospedada por ela. Isso já era assim **antes** desta funcionalidade — não foi introduzido por ela. Tentei confirmar isso também na documentação oficial da InfinitePay, mas o acesso à internet neste ambiente de desenvolvimento estava bloqueado para os domínios da InfinitePay; a conclusão acima vem da leitura do código-fonte já existente no projeto, que documenta explicitamente "contém apenas os dois endpoints oficiais documentados".

Por isso: **`billing_plans.max_installments` é usado apenas para exibição** (o rótulo do plano, e o `<select>` de parcelas na página de cobrança avulsa) — nunca é enviado à InfinitePay. O teto de 12x já pedido é respeitado na interface (planos nunca oferecem mais que 12 parcelas, mesmo o plano de 2 anos, que nunca vira "24x") mas **não é imposto pela API do gateway** — o cliente final decide o parcelamento real na tela de checkout da própria InfinitePay, dentro do limite que a InfinitePay mesma pratica. Se a InfinitePay futuramente documentar um parâmetro de teto de parcelas no endpoint `/links`, ele deve ser adicionado em `_shared/infinitepay.ts`/`CreateLinkPayload` e usado tanto por `create-infinitepay-checkout` quanto por `select-plan-offer` e `create_subscription_renewal_charge` (Edge Function `whatsapp-agent-api`) — os 3 pontos que hoje chamam `callCreateLink()`.

## Fluxo completo

**Administrador:** Login → Planos → Criar/editar planos → Cliente → Criar oferta → Selecionar planos → Gerar link → Enviar WhatsApp (mesma fila `DB.whatsapp.enqueue`/`enqueue_whatsapp_message`, nenhuma integração paralela).

**Cliente:** WhatsApp → Abrir oferta (`oferta.html?token=...`) → Comparar planos → Escolher → Checkout InfinitePay → Pagamento.

**Sistema:** Webhook → Pagamento confirmado → Cobrança paga → Recibo → Assinatura ativa → Validade/próxima renovação calculada.

## Arquivos

**Novos:**
- `sql/billing_plans.sql` — migration principal (tabelas, RLS, RPCs).
- `sql/seed_billing_plans.sql` — seed opcional dos 3 planos iniciais (Mensal/Anual/2 anos), idempotente, para todas as empresas cadastradas.
- `supabase/functions/select-plan-offer/index.ts` — Edge Function pública (única nova).
- `planos.html`, `plano-form.html`, `assets/js/planos.js`, `assets/js/plano-form.js` — painel administrativo.
- `oferta.html`, `assets/js/oferta.js` — página pública mobile-first.
- `smart-billing-agent/src/subscriptions.js` — renovação mensal no worker.

**Alterados:**
- `assets/js/data.js` — `DB.planos`, `DB.ofertas`, `DB.assinaturas` (backend real + demo).
- `assets/js/layout.js` — item de menu "Planos".
- `assets/js/whatsapp-templates.js` — `offerMessage()`/`publicOfferUrl()`.
- `assets/css/components.css`, `assets/css/pages.css` — componente `.plan-card` (reaproveitado no painel e na página pública) e `.offer-page`.
- `cliente-historico.html`, `assets/js/cliente-historico.js` — seção "Plano atual" + criação de oferta.
- `supabase/functions/whatsapp-agent-api/index.ts` — ações `list_due_subscription_renewals`/`create_subscription_renewal_charge`.
- `supabase/config.toml` — registra `select-plan-offer` como pública (`verify_jwt = false`).
- `smart-billing-agent/src/agentApi.js`, `smart-billing-agent/src/scheduler.js` — wiring da renovação mensal.

**Não alterados** (e não precisavam ser): `supabase/functions/create-infinitepay-checkout/index.ts`, `supabase/functions/infinitepay-webhook/index.ts`, `supabase/functions/check-infinitepay-payment/index.ts` — toda a integração de planos com o pagamento acontece por extensão das RPCs que essas functions já chamavam, não por edição das functions em si.

## Como testar (empiricamente, não só ler o código)

1. `sql/supabase_schema.sql` → `sql/infinitepay_integration.sql` → `sql/whatsapp_agent.sql` → `sql/billing_plans.sql` → `sql/seed_billing_plans.sql`, nessa ordem, num Postgres local ou projeto de teste.
2. Criar uma oferta com `create_plan_offer()`, ler via `get_public_plan_offer_by_token()`.
3. Chamar `select_plan_offer()` — confirmar que a cobrança criada tem o valor **exato** do plano no banco, nunca um valor "enviado" (não existe parâmetro de valor na função).
4. Repetir a mesma chamada (clique duplo) — confirmar que só existe 1 cobrança.
5. Chamar `register_manual_payment()`/`register_infinitepay_payment()` na cobrança — confirmar `client_subscriptions.status='active'` e `ends_at`/`next_billing_at` corretos para cada tipo de plano.
6. Simular uma assinatura mensal vencida (`next_billing_at` no passado) e chamar `create_subscription_renewal_charge()` — confirmar idempotência rodando de novo e sob concorrência real.
7. Testar uma cobrança avulsa antiga (sem `plan_id`) através de `register_manual_payment()` — confirmar que continua funcionando exatamente como antes, sem nenhuma assinatura sendo criada.

## Passos manuais pendentes (não executados por esta sessão)

Nenhuma migration foi aplicada em produção, nenhuma Edge Function foi implantada, nenhuma mensagem real foi enviada. Antes de usar em produção:

1. Rodar `sql/billing_plans.sql` no SQL Editor do Supabase (produção), depois de confirmar que `sql/infinitepay_integration.sql` e `sql/whatsapp_agent.sql` já foram aplicadas.
2. Rodar `sql/seed_billing_plans.sql` (opcional) para criar os 3 planos iniciais.
3. `supabase functions deploy select-plan-offer`.
4. Redeploy de `supabase functions deploy whatsapp-agent-api` (ganhou as 2 novas ações de renovação).
5. Reiniciar o worker da VPS (`pm2 restart smart-billing-worker`) para carregar `subscriptions.js`.
6. Testar o fluxo completo uma vez em produção com um cliente/plano de teste antes de divulgar links reais.
