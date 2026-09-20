import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

test('Demo: snapshot antigo, CRUD, overrides, persistência e exclusão do cliente', async () => {
  const storage = new Map();
  const source = readFileSync(new URL('../assets/js/data.js', import.meta.url), 'utf8');
  function boot() {
    const context = vm.createContext({ window: { SMART_BILLING_CONFIG: { useDemoMode: true } },
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      crypto: webcrypto, setTimeout: fn => { fn(); }, console });
    return vm.runInContext(`${source}\nDB`, context);
  }
  let db = boot();
  assert.equal((await db.sistemas.listar()).length, 0);
  const client = (await db.clientes.list())[0];
  const s = await db.sistemas.criar({ clienteId: client.id, nome: 'Demo', dominio: 'example.com',
    assinaturaId: null, diasCarencia: 3, bloqueioAutomatico: true });
  assert.match(s.chave, /^[0-9a-f-]{36}$/);
  assert.equal(s.acesso.status, 'active');
  assert.equal((await db.sistemas.suspender(s.id)).acesso.status, 'suspended');
  assert.equal((await db.sistemas.liberar(s.id)).acesso.status, 'active');
  assert.equal((await db.sistemas.voltarAutomatico(s.id)).manualOverride, 'none');
  await db.sistemas.atualizar(s.id, { chave: 'forged', clienteId: 'other', nome: 'Renamed' });
  assert.equal((await db.sistemas.obter(s.id)).chave, s.chave);
  db = boot();
  assert.equal((await db.sistemas.obter(s.id)).nome, 'Renamed');
  assert.equal((await db.sistemas.listar('other')).length, 0);
  assert.equal((await db.sistemas.atualizar(s.id, { ativo: false })).acesso.status, 'suspended');
  await assert.rejects(db.sistemas.criar({ clienteId: client.id, assinaturaId: 'foreign' }), /Assinatura/);
  await db.clientes.remove(client.id);
  assert.equal((await db.sistemas.listar()).length, 0);
});
