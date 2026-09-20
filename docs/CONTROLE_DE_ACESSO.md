# Controle de acesso dos sistemas

Implementado exclusivamente no Smart-Billingg, na branch `feat/system-access-control`.
Nenhum código foi adicionado ao TA Construção ou a outro sistema cliente. Nenhum
webhook, cobrança ou pagamento paralelo foi criado. Não houve merge na main.

## Auditoria da arquitetura existente

- Frontend estático HTML/JS, shell `SBLayout`, componentes CSS existentes e sessão
  `SB_AUTH.requireSession`. Nova página segue esse padrão.
- `assets/js/data.js` abstrai Supabase e localStorage; `DB.sistemas` segue essa
  abstração, com mapeamento dos campos SQL para os nomes usados no painel.
- `billing_plans.sql` já cria `client_subscriptions` e `charges.subscription_id`.
  O atraso efetivo é determinado por `due_date`, sem exigir status `overdue`.
- As permissões de planos usam `owner`, `admin`, `employee` para criar/editar;
  o módulo adota os mesmos papéis. `viewer` pode visualizar.
- Divergência preexistente: `late_fees_and_interest.sql` substitui as funções
  de pagamento sem chamar `activate_subscription_on_charge_paid`, presente em
  `billing_plans.sql`. A ordem de instalação pode deixar o status da assinatura
  sem atualização. Esta feature não reescreve essas funções: acesso deriva da
  cobrança confirmada, portanto sua liberação funciona independentemente disso.
  Corrigir o ciclo operacional de assinaturas exige uma revisão financeira separada.

## Arquivos

Criados:

- `sql/system_access_control.sql`: tabelas, índices, integridade, RLS, cálculo,
  wrappers de consulta e auditoria.
- `sql/test_system_access_control.sql`: fixtures transacionais e cenários A–O,
  permissões e pagamentos reais das funções existentes; termina em rollback.
- `supabase/functions/system-access/index.ts` e `handler.ts`: Edge Function e
  contrato HTTP testável.
- `sistemas.html` e `assets/js/sistemas.js`: cadastro, edição, filtro por cliente,
  status, overrides, bloqueio automático, desativação administrativa e cópia da chave.
- `tests/package.json`, `package-lock.json`, `system-access-db.mjs`,
  `system-access-http.test.mjs`, `system-access-demo.test.mjs`,
  `system-access-browser.mjs`: validação reproduzível.
- Este documento.

Alterados: `assets/js/data.js`, `assets/js/layout.js`,
`assets/js/cliente-historico.js`, `cliente-historico.html`, `supabase/config.toml`.

## Regra única no banco

`calculate_system_access(client_systems)` é a única implementação da regra real.
É interna, não executável por público, anon ou authenticated. `get_system_access`
carrega a linha pelo UUID e chama esse cálculo. O painel usa `list_system_access`,
que valida participação na empresa antes de delegar ao mesmo caminho.

Prioridade:

| Condição | Resultado |
|---|---|
| Chave inexistente | HTTP 404, sem `allowed` ou estado de suspensão |
| `active=false` | suspended, inclusive com force_active |
| `manual_override=force_suspended` | suspended |
| `manual_override=force_active` | active |
| Bloqueio automático desligado | active |
| Sem assinatura | active |
| Sem cobranças vencidas relevantes | active |
| Mais antiga vencida há 1 a grace_days dias | grace, allowed=true |
| Mais antiga vencida há mais de grace_days dias | suspended, allowed=false |

Só entram cobranças da **assinatura vinculada**, do mesmo cliente e empresa,
cujo status não seja `paid` nem `cancelled`. Avulsas e outras assinaturas ficam
fora do cálculo. A data de negócio é explicitamente `America/Sao_Paulo`.

Padrão de carência: 3 dias, configurável entre 0 e 365. Vencimento dia 10:
dias 11–13 em carência, dia 14 suspenso. No dia 11, `grace_days_remaining=2`;
no dia 13, zero (dias restantes **após hoje**, acesso liberado durante esse dia).

Assinatura cancelada/expirada não suspende por si só: cobranças abertas ainda
contam, pagas/canceladas não contam. `ends_at` não é usado como inadimplência.
Exclusão da assinatura deixa `subscription_id=null` e libera automaticamente;
registre suspensão manual antes se a intenção for encerrar também o acesso.
Exclusão do cliente remove seus sistemas e logs em cascata. Suspender/desativar
um sistema **não exclui** registros, arquivos ou dados do cliente.

Pagamento manual ou InfinitePay que realmente quita a cobrança faz a próxima
consulta devolver active, salvo outro débito relevante ou bloqueio administrativo.
Pagamento divergente registrado em `payment_reviews` não quita a cobrança e não
libera acesso. Nenhum novo webhook ou sincronização adicional é necessário.

## Auditoria e segurança

`last_status` é apenas o último estado observado para detectar transições; não
é a fonte de verdade. Consultas concorrentes são serializadas por bloqueio da
linha. Se o estado não mudou, não há update nem novo log. Alterações administrativas
relevantes registram configuração anterior/nova e `auth.uid()` em metadata.
Não há cron: transições decorrentes de data/pagamento são registradas na próxima
consulta, com a hora de observação. Estados intermediários nunca observados não
são reconstruídos retroativamente.

RLS nas duas tabelas. Membros leem somente sua empresa. Owner/admin/employee
criam/editam sistemas; viewer não altera. Logs não podem ser inseridos, editados
ou apagados pelo usuário. Grants por coluna protegem chave, identidade, timestamps
e snapshot. Chave UUID v4 é gerada pelo banco. FKs compostas impedem vínculos com
cliente/assinatura de outra empresa ou com assinatura de outro cliente.

`get_system_access` só pode ser executada por `service_role`. Todas as funções
SECURITY DEFINER fixam search_path e têm grants explícitos. Não há SELECT anônimo
nas novas tabelas nem service_role no frontend.

`verify_jwt=false` apenas para essa function, porque sistemas externos não têm
sessão Supabase. O endpoint aceita um único UUID opaco e devolve somente
`allowed`, `status`, `checked_at` e, em carência, `grace_days_remaining`.
Resposta é filtrada por whitelist. Nunca expõe identidade ou informações financeiras.
CORS permite GET/OPTIONS de qualquer origem, sem cookies; `Cache-Control: no-store`.
Nenhuma chave, erro interno ou payload financeiro é escrito nos logs da function.

## Contrato fail-open para integração futura

`GET https://PROJECT_REF.supabase.co/functions/v1/system-access?key=UUID`

Só bloquear após HTTP 200 e resposta íntegra, recente, com
`allowed === false` e `status === 'suspended'`. Timeout, erro de conexão,
404, 400, 500/503, JSON inválido ou contrato inconsistente devem manter acesso.
Não transformar o último estado suspenso em bloqueio permanente após falha de
consulta. A integração futura deve definir timeout, validar o contrato e evitar
cache prolongado. O endpoint usa timeout de 8 segundos para o RPC.

Esta etapa entrega o contrato e o servidor; a política fail-open só estará
efetivamente aplicada no cliente quando sua integração futura for implementada.

## Instalação no Supabase

Em um projeto existente com schema e planos já instalados:

1. No SQL Editor, executar **somente** `sql/system_access_control.sql` inteiro.
   Requer PostgreSQL 15+ (FK com `ON DELETE SET NULL (subscription_id)`).
   É idempotente e transacional; não recria as funções financeiras existentes.
2. Publicar a function:

```sh
supabase functions deploy system-access --project-ref SEU_PROJECT_REF
```

O `supabase/config.toml` já define `verify_jwt=false`. Os únicos secrets usados
são `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, fornecidos pelo ambiente de
Edge Functions do Supabase. Não há novo secret de gateway ou cliente.

3. Publicar os arquivos estáticos alterados pelo processo habitual do projeto.
4. Em ambiente de homologação, cadastrar um sistema e testar o endpoint com sua
   chave, além de confirmar os embeds de cliente/assinatura pelo painel.

Não reaplicar `billing_plans.sql` ou a migração de juros apenas para instalar
esta feature: elas substituem funções financeiras e a ordem é relevante.
Migração, deploy e publicação não foram executados em produção nesta entrega.

## Testes e resultados

```sh
npm ci --prefix tests
npm test --prefix tests
node --check assets/js/data.js
node --check assets/js/sistemas.js
node --check assets/js/cliente-historico.js
node --check assets/js/layout.js
deno check --node-modules-dir=none --no-lock supabase/functions/system-access/index.ts
git diff --check
```

O runner PGlite 0.5.8 carrega as migrações reais de schema, InfinitePay, WhatsApp,
planos e juros, depois aplica a nova migração duas vezes. Simula somente a
infraestrutura Auth do Supabase; usa `gen_random_uuid()` nativa em lugar da
extensão pgcrypto. Executa SQL/PLpgSQL, constraints, triggers e RLS de verdade.

Resultados obtidos: A–O aprovados, carência zero, cobrança mais antiga,
pagamento manual/InfinitePay, revisão divergente, integridade entre empresas e
clientes, RLS anon/viewer/employee/admin/owner/service_role, proteção da chave,
snapshot e auditoria, ausência de logs repetidos e reexecução da migração.
Seis testes HTTP e um teste demo aprovados. `node --check`, `deno check` e
`git diff --check` aprovados.

Teste de navegador opcional: instalar Playwright em uma pasta de ferramentas,
definir `PLAYWRIGHT_MODULE` para seu `index.mjs` e executar
`node tests/system-access-browser.mjs`. Requer Microsoft Edge instalado.
Foi executado com Edge headless em desktop e largura mobile de 390px: cadastro,
edição, suspensão/liberação, retorno ao automático e histórico aprovados, sem
overflow horizontal ou erros JavaScript. Requisições externas são bloqueadas;
o teste usa exclusivamente o demo e um servidor local efêmero.

Limites: PGlite não substitui homologação do gateway Supabase/PostgREST e não
testa concorrência entre conexões PostgreSQL independentes. O teste visual não
inclui fontes externas. Demo usa snapshots ilustrativos, explicitamente
identificados na página; não replica o cálculo financeiro SQL em JavaScript.
Deploy, validação com autenticação real e integração futura do cliente continuam
pendentes. O conflito preexistente da ativação da assinatura foi documentado acima.
