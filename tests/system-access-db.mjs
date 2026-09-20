// PostgreSQL em WASM, sem rede/banco real. Instale as dependências em tests/.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;`);
  for (const file of ['supabase_schema','infinitepay_integration','whatsapp_agent','billing_plans','late_fees_and_interest','system_access_control','system_access_control']) {
    // PGlite fornece gen_random_uuid nativamente, sem a extensão pgcrypto.
    const sql = readFileSync(new URL(`../sql/${file}.sql`, import.meta.url), 'utf8').replace('create extension if not exists "pgcrypto";', '');
    await db.exec(sql);
  }
  console.log('PASS: migrations reais + system_access_control aplicada duas vezes');
  await db.exec(readFileSync(new URL('../sql/test_system_access_control.sql', import.meta.url), 'utf8'));
  console.log('PASS: cenários A–O, isolamento, permissões, auditoria e liberação');
  // Confirma o contrato dos FKs usado nos embeds PostgREST do data layer.
  const fks = await db.query(`select conname from pg_constraint where conrelid='public.client_systems'::regclass and contype='f'`);
  assert(fks.rows.some(r => r.conname === 'systems_client_fk'));
  assert(fks.rows.some(r => r.conname === 'systems_subscription_fk'));
} finally { await db.close(); }
