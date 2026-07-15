# Edge Functions — Checkout Integrado da InfinitePay

Esta pasta contém as três Edge Functions que implementam a integração real de
pagamentos com o **Checkout Integrado da InfinitePay**. Elas usam somente os
dois endpoints oficiais documentados pela InfinitePay:

- `POST https://api.checkout.infinitepay.io/links` — cria o link de checkout.
- `POST https://api.checkout.infinitepay.io/payment_check` — confirma o
  status de um pagamento.

Não existe nenhuma API key privada nessa integração — a autenticação usada
para criar o link é a própria **InfiniteTag** (o "handle" da sua conta,
sem o símbolo `$`).

| Function | Chamada por | Responsabilidade |
|---|---|---|
| `create-infinitepay-checkout` | Frontend (painel), autenticado | Cria/reaproveita o checkout de uma `charge` existente e salva `checkout_url` |
| `infinitepay-webhook` | InfinitePay (servidor a servidor) | Recebe a notificação de pagamento, confirma via `payment_check` e registra `payments`/`charges`/`receipts` |
| `check-infinitepay-payment` | Página pública `pagamento-confirmado.html` | Confirma o pagamento no retorno do checkout (fallback/duplicidade do webhook) |

Os helpers compartilhados (conversão de valores, validação de payload,
chamadas HTTP aos dois endpoints, CORS) ficam em `_shared/infinitepay.ts`.

## 1. Como habilitar o Checkout Integrado na InfinitePay

1. Acesse sua conta InfinitePay (app ou painel web).
2. Localize a seção de **Checkout Integrado / Integrações** e habilite o recurso
   para a sua conta, se ainda não estiver ativo.
3. Anote sua **InfiniteTag** (o `@handle` da sua conta) — ela aparece no seu
   perfil/link de cobrança. Use-a **sem o símbolo `$`** ao configurar o secret
   `INFINITEPAY_HANDLE` (passo 3 abaixo).

## 2. Onde encontrar a InfiniteTag

A InfiniteTag é o mesmo identificador usado nos seus links de cobrança
pessoais da InfinitePay (ex.: `$suaempresa` → use apenas `suaempresa`).
Confirme no app/painel da InfinitePay, na tela de perfil ou de link de
pagamento.

## 3. Secrets a cadastrar

Nunca coloque estes valores em arquivo de código. Configure via Supabase CLI:

```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF

supabase secrets set INFINITEPAY_HANDLE=suaempresa
supabase secrets set PUBLIC_APP_URL=https://seunominio.com
```

- `INFINITEPAY_HANDLE`: a InfiniteTag, sem `$`.
- `PUBLIC_APP_URL`: a URL pública onde o site estático está hospedado (sem
  barra no final), usada para montar a `redirect_url` do checkout
  (`PUBLIC_APP_URL/pagamento-confirmado.html?token=...`).

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já ficam disponíveis
automaticamente em toda Edge Function — não é necessário configurá-los.

## 4. Executar a migração SQL

No SQL Editor do Supabase, rode o conteúdo de `sql/infinitepay_integration.sql`
inteiro (depois de já ter rodado `sql/supabase_schema.sql` alguma vez). É
idempotente — pode ser executado novamente sem apagar dados.

## 5. Deploy das três Edge Functions

Com Node/Supabase CLI instalados:

```bash
supabase functions deploy create-infinitepay-checkout
supabase functions deploy infinitepay-webhook
supabase functions deploy check-infinitepay-payment
```

O `verify_jwt` de cada function já vem definido em `supabase/config.toml`
(`create-infinitepay-checkout = true`, as outras duas = `false`) — não é
necessário passar `--no-verify-jwt` manualmente.

### Sem Node/CLI na máquina (deploy pelo painel)

1. No painel do Supabase, vá em **Edge Functions → Create a new function**.
2. Crie as três funções com os nomes exatos: `create-infinitepay-checkout`,
   `infinitepay-webhook`, `check-infinitepay-payment`.
3. Cole o conteúdo de cada `index.ts` (e de `_shared/infinitepay.ts` como um
   arquivo adicional na mesma function, ou repita o conteúdo do helper
   diretamente em cada função, já que o editor web nem sempre suporta pastas
   compartilhadas).
4. Em **Settings** de `infinitepay-webhook` e `check-infinitepay-payment`,
   desmarque a exigência de JWT (equivalente a `verify_jwt = false`).
5. Cadastre os secrets em **Edge Functions → Secrets**.

## 6. Como obter as URLs

- **Webhook URL** (para configurar caso a InfinitePay peça uma URL fixa, além
  da enviada dinamicamente em cada checkout):
  `https://SEU_PROJECT_REF.supabase.co/functions/v1/infinitepay-webhook`
- **Redirect URL**: gerada automaticamente pela function
  `create-infinitepay-checkout` a partir de `PUBLIC_APP_URL`.

## 7. Como testar com uma cobrança de valor baixo

1. No painel do Smart Billing, crie uma cobrança com valor baixo (ex.: R$ 1,00).
2. Confirme que o checkout foi gerado (toast "Link de pagamento criado com
   sucesso" e o link aparece nas ações da cobrança).
3. Abra o link público da cobrança (`cobranca-publica.html?token=...`) e
   clique em "Pagar agora".
4. Complete o pagamento real na InfinitePay (Pix ou cartão) com o valor baixo.
5. Você será redirecionado para `pagamento-confirmado.html` — a tela deve
   mostrar "Verificando pagamento…" e depois "Pagamento aprovado!".

## 8. Como acompanhar os logs

```bash
supabase functions logs create-infinitepay-checkout
supabase functions logs infinitepay-webhook
supabase functions logs check-infinitepay-payment
```

Ou pelo painel, em **Edge Functions → (nome da function) → Logs**. Os logs
registram apenas nome da função, `charge_number`/`order_nsu`, status da
chamada externa e tipo de erro resumido — nunca segredos, JWT completo ou
dados de cartão.

## 9. O que verificar no banco após o pagamento

No SQL Editor do Supabase:

```sql
select * from public.webhook_events order by created_at desc limit 5;
select * from public.payments where provider = 'infinitepay' order by created_at desc limit 5;
select * from public.charges where charge_number = 'COB-XXXXXX';
select * from public.receipts order by created_at desc limit 5;
```

Confirme: `webhook_events.processed = true`, um único `payments` com
`provider_transaction_id` preenchido, `charges.status = 'paid'` e
`paid_at` preenchido, e um `receipts` correspondente.

## 10. Como desfazer um teste

```sql
-- Substitua pelos IDs/códigos reais do teste.
delete from public.receipts where charge_id = 'CHARGE_ID_DO_TESTE';
delete from public.payments where charge_id = 'CHARGE_ID_DO_TESTE';
update public.charges set status = 'pending', paid_at = null, checkout_url = null, provider_reference = null
  where id = 'CHARGE_ID_DO_TESTE';
delete from public.webhook_events where event_id = 'TRANSACTION_NSU_DO_TESTE';
```

## 11. Regras importantes

- **Nunca marque uma cobrança como paga apenas pelo redirect.** A InfinitePay
  não assina criptograficamente o webhook nesta integração — a confirmação
  obrigatória via `POST /payment_check` é a principal validação de
  autenticidade antes de gravar qualquer coisa no banco, tanto no webhook
  quanto na tela de retorno.
- **Não existe API key privada a ser inventada nesta integração.** A única
  credencial usada é a InfiniteTag (`INFINITEPAY_HANDLE`), que identifica a
  conta, não autentica requisições administrativas.
- **`PUBLIC_APP_URL`**: aponte para `http://localhost:PORTA` (ou o endereço
  da sua rede local) durante o desenvolvimento, e para o domínio real de
  produção (ex.: `https://seusite.com` ou `https://usuario.github.io/repo`)
  antes de publicar. Atualize o secret com `supabase secrets set
  PUBLIC_APP_URL=...` sempre que o domínio mudar.

## 12. Limitações conhecidas da API (nesta integração)

- O payload do webhook e a resposta de `payment_check` não documentam um
  campo de assinatura/HMAC — por isso a confirmação via `payment_check` é
  obrigatória antes de qualquer gravação.
- A resposta de `payment_check` não documenta o `capture_method` (pix/cartão)
  nem o número de parcelas: a tela de retorno repassa o `capture_method` que
  a própria InfinitePay anexa à `redirect_url`, com fallback para "pix"
  quando ausente; o número de parcelas confirmado por essa consulta pública
  também assume 1 quando não informado (o webhook, que recebe o payload
  completo, não tem essa limitação e sempre usa os valores reais).
- Não há endpoint de estorno/cancelamento documentado nesta integração —
  qualquer reconciliação de estorno deve ser feita manualmente no banco.
