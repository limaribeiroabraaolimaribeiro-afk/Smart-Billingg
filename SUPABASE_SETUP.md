# Configurando o Supabase no Smart Billing

Este guia explica, passo a passo, como sair do **modo de demonstração**
(dados simulados em localStorage) e ligar o Smart Billing a um banco
PostgreSQL real no Supabase, com login de verdade.

Não é necessário saber programar para seguir este guia — apenas copiar e
colar em alguns lugares indicados.

---

## 1. Criar o projeto no Supabase

1. Acesse [supabase.com](https://supabase.com) e crie uma conta (ou faça login).
2. Clique em **New project**.
3. Escolha uma organização, dê um nome ao projeto (ex.: `smart-billing`),
   defina uma senha forte para o banco de dados (guarde-a em local seguro) e
   escolha a região mais próxima dos seus usuários.
4. Aguarde alguns minutos até o projeto ficar com status **Active**.

---

## 2. Abrir o SQL Editor

1. Dentro do projeto, no menu lateral esquerdo, clique em **SQL Editor**.
2. Clique em **New query** para abrir um editor em branco.

---

## 3. Executar `sql/supabase_schema.sql`

1. Abra o arquivo `sql/supabase_schema.sql` (na raiz deste projeto) em
   qualquer editor de texto.
2. Selecione todo o conteúdo (Ctrl+A) e copie (Ctrl+C).
3. Cole no SQL Editor do Supabase.
4. Clique em **Run** (ou Ctrl+Enter). O script cria tabelas, tipos,
   triggers, funções, views e todas as políticas de segurança (RLS) de uma
   só vez — não precisa rodar em partes.
5. Se aparecer "Success. No rows returned", deu tudo certo.

> O script é seguro para rodar mais de uma vez (ele substitui/ignora o que
> já existir), então não tem problema executá-lo novamente se precisar.

---

## 4. Localizar a Project URL

1. No menu lateral, vá em **Project Settings** (ícone de engrenagem) →
   **Data API** (ou **API**, dependendo da versão do painel).
2. Copie o valor de **Project URL** — algo como
   `https://xxxxxxxxxxxx.supabase.co`.

---

## 5. Localizar a chave pública (anon key)

1. Na mesma tela (**Project Settings → API**), procure por **Project API
   keys**.
2. Copie a chave chamada **anon** ou **public** (em painéis mais novos pode
   aparecer como **publishable key**). Ela é segura para uso no navegador.
3. **Nunca** copie a chave **service_role** — essa é secreta e não deve
   sair do backend (veja a seção 13).

---

## 6. Onde colocar essas informações no projeto

Abra o arquivo `assets/js/config.js` e preencha as duas linhas indicadas:

```javascript
const supabaseUrl = 'https://xxxxxxxxxxxx.supabase.co'; // sua Project URL
const supabaseAnonKey = 'eyJhbGciOi...'; // sua anon key
```

Salve o arquivo. Assim que os dois campos estiverem preenchidos, o sistema
detecta automaticamente que o Supabase está configurado
(`useDemoMode` passa a `false`) e para de usar dados simulados.

---

## 7. Ativar autenticação por e-mail e senha

Normalmente já vem ativado por padrão em projetos novos, mas confirme:

1. No menu lateral, vá em **Authentication** → **Providers** (ou **Sign In / Providers**).
2. Confirme que **Email** está habilitado.
3. Em **Authentication → Settings**, se estiver testando localmente, você
   pode desativar temporariamente a confirmação por e-mail ("Confirm email")
   para conseguir logar imediatamente após o cadastro — lembre-se de
   reativar antes de ir para produção.

---

## 8. Criar o primeiro usuário

Você tem duas opções:

**Opção A — pelo próprio sistema (recomendado):**
1. Abra `login.html` no navegador.
2. Clique na aba **Criar conta**.
3. Preencha nome, nome da empresa, telefone, e-mail e senha, e envie.
4. Isso cria automaticamente: seu usuário no Supabase Auth, seu perfil, uma
   empresa inicial e o seu vínculo como **owner** dessa empresa (tudo via
   trigger `handle_new_user`, já incluso no schema).

**Opção B — pelo painel do Supabase:**
1. Vá em **Authentication → Users → Add user**.
2. Preencha e-mail e senha e confirme.
3. O mesmo trigger cria profile/empresa/membership automaticamente.

---

## 9. Como testar o login

1. Abra `login.html`.
2. Entre com o e-mail e senha criados no passo anterior.
3. Você deve ser redirecionado para `index.html` (o Dashboard).
4. Tente acessar `index.html` diretamente sem estar logado (ex.: em uma aba
   anônima) — você deve ser redirecionado de volta para `login.html`. Isso
   confirma que a proteção de rotas está funcionando.

---

## 10. Como testar clientes e cobranças

1. No painel, vá em **Clientes → Novo cliente** e cadastre um cliente de teste.
2. Vá em **Cobranças → Nova cobrança**, selecione o cliente, preencha os
   dados e crie a cobrança.
3. Confira se ela aparece na listagem de Cobranças e no Dashboard.
4. Copie o link de pagamento da cobrança (ação "Copiar link de pagamento")
   e abra em uma aba anônima — a página pública deve carregar mesmo sem
   login.
5. No painel, use a ação "Marcar como pago" na cobrança — isso deve gerar
   automaticamente um registro em Pagamentos e um recibo em Recibos.

---

## 11. Como confirmar que o RLS está funcionando

Uma forma simples de verificar, direto no SQL Editor do Supabase:

```sql
-- Deve retornar apenas as empresas do usuário logado no contexto atual.
-- Rodado pelo SQL Editor (como admin), isto retorna tudo — o teste real
-- é feito pelo próprio app com dois usuários diferentes:
select * from public.companies;
```

Teste prático mais confiável:
1. Crie dois usuários diferentes (duas contas) pelo `login.html`.
2. Cadastre um cliente com a Conta A.
3. Faça login com a Conta B e confirme que o cliente da Conta A **não
   aparece** na listagem — cada empresa só vê os próprios dados.

---

## 12. Como publicar o sistema

Como o projeto é HTML/CSS/JS puro (sem build step), você pode publicar em
qualquer hospedagem de arquivos estáticos:

- **Netlify / Vercel (modo estático)**: arraste a pasta do projeto ou
  conecte o repositório Git — não é necessário configurar comando de build.
- **GitHub Pages**: habilite Pages apontando para a raiz do repositório.
- Qualquer servidor HTTP simples também funciona, já que tudo é HTML/CSS/JS.

Antes de publicar, confirme que `assets/js/config.js` já está com as chaves
reais preenchidas (e não vazio), e que a confirmação de e-mail (passo 7)
está reativada para produção.

---

## 13. Quais chaves podem ficar no frontend

- ✅ **Project URL** (`supabaseUrl`)
- ✅ **anon / publishable key** (`supabaseAnonKey`) — é protegida pelo RLS;
  sozinha, ela não dá acesso a nada que as políticas não permitam.

## 14. Quais chaves NUNCA podem ficar no frontend

- ❌ **service_role key** do Supabase (ignora todo o RLS — só pode existir
  em Edge Functions/backend, nunca em arquivos servidos ao navegador).
- ❌ **InfiniteTag / `INFINITEPAY_HANDLE`** — mesmo não sendo uma senha, ela
  só é usada dentro das Edge Functions para montar as chamadas oficiais à
  InfinitePay; o frontend nunca precisa dela diretamente.
- ❌ Senha do banco de dados Postgres.

Não existe, nesta integração, nenhuma API key privada ou segredo de
assinatura de webhook da InfinitePay a ser cadastrado — apenas a InfiniteTag
(identificador público da conta) e a URL pública do site.

---

## 15. Checkout Integrado da InfinitePay (implementado)

A integração real de pagamentos já está implementada em
`supabase/functions/create-infinitepay-checkout`,
`supabase/functions/infinitepay-webhook` e
`supabase/functions/check-infinitepay-payment`. O guia completo — como
habilitar o Checkout Integrado na InfinitePay, onde encontrar a InfiniteTag,
quais secrets cadastrar, como rodar `sql/infinitepay_integration.sql`, como
publicar as três functions, como testar com uma cobrança de valor baixo, como
acompanhar logs, o que conferir no banco e como desfazer um teste — está em
[`supabase/functions/README.md`](supabase/functions/README.md).

Resumo rápido dos secrets:

```bash
supabase secrets set INFINITEPAY_HANDLE=suaempresa   # sem o símbolo $
supabase secrets set PUBLIC_APP_URL=https://seudominio.com
```

Esses segredos ficam disponíveis apenas dentro das Edge Functions
(`create-infinitepay-checkout`, `infinitepay-webhook`,
`check-infinitepay-payment`), nunca no navegador do usuário final. **Nunca
marque uma cobrança como paga apenas pelo redirect de retorno** — a
confirmação real sempre passa pela consulta oficial `payment_check` da
InfinitePay dentro das Edge Functions.

---

## Dados de teste (opcional)

Se quiser popular o sistema com alguns clientes e cobranças de exemplo sem
digitar tudo manualmente, veja `sql/seed_demo.sql` — ele explica como
descobrir o ID da sua empresa e rodar a função de seed apontando para ela.
