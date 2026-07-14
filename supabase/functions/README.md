# Edge Functions — integração futura com a InfinitePay

Esta pasta contém **apenas a estrutura preparada** para a futura integração de
pagamentos com a InfinitePay. Nenhuma das funções abaixo está implementada de
verdade — são esqueletos documentados, sem credenciais e sem lógica de
pagamento simulada, propositalmente.

Por quê nenhuma chave/segredo aparece aqui? Porque a chave secreta da
InfinitePay **nunca** pode rodar no navegador (o `SMART_BILLING_CONFIG` no
frontend só guarda um `clientId` público). Toda chamada que exige a chave
secreta precisa passar por um destes três backends (Supabase Edge Functions,
que rodam em servidor, nunca no navegador do cliente):

| Function | Chamada por | Responsabilidade futura |
|---|---|---|
| `create-infinitepay-checkout` | Frontend (painel), autenticado | Criar uma cobrança/checkout na InfinitePay para uma `charge` existente e devolver a `checkout_url` |
| `infinitepay-webhook` | InfinitePay (servidor a servidor) | Receber notificações de pagamento aprovado/recusado e atualizar `payments`/`charges`/`receipts` |
| `check-infinitepay-payment` | Frontend (painel) ou cron | Consultar o status atual de um pagamento diretamente na API da InfinitePay (fallback caso o webhook falhe) |

## Como isso vai se conectar ao banco (quando implementado)

- As três functions devem usar a **service_role key** do Supabase (nunca a
  anon key) para poder gravar em `payments`/`receipts`/`webhook_events`
  ignorando RLS — é seguro porque a service_role só existe no servidor da
  function, nunca é enviada ao navegador.
- `infinitepay-webhook` deve gravar o payload bruto em `webhook_events`
  **antes** de processar, usando a constraint `unique (provider, event_id)`
  do schema para nunca processar o mesmo evento duas vezes.
- Ao confirmar um pagamento, a function deve inserir em `payments`, inserir
  o `receipts` correspondente e atualizar `charges.status = 'paid'` — o
  mesmo resultado que `register_manual_payment()` produz manualmente hoje.

## Segredos (a configurar quando a integração for implementada)

Nunca colocar estes valores em arquivo de código. Configurar via:

```bash
supabase secrets set INFINITEPAY_API_KEY=xxxxx
supabase secrets set INFINITEPAY_WEBHOOK_SECRET=xxxxx
```

## Deploy (quando as functions forem implementadas)

```bash
supabase functions deploy create-infinitepay-checkout
supabase functions deploy infinitepay-webhook --no-verify-jwt
supabase functions deploy check-infinitepay-payment
```

`--no-verify-jwt` é necessário no webhook porque quem chama é a InfinitePay,
não um usuário logado — a validação de autenticidade nesse caso deve ser
feita conferindo a assinatura/segredo enviado pela InfinitePay no cabeçalho
da requisição (a implementar).
