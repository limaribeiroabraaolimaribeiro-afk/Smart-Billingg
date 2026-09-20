import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/system-access/handler.ts';

const key = '12345678-1234-4234-8234-123456789012';
const request = (suffix = `?key=${key}`, method = 'GET') => new Request(`https://example.com/system-access${suffix}`, { method });
for (const status of ['active', 'grace', 'suspended']) {
  test(`HTTP: ${status}, whitelist e no-store`, async () => {
    const response = await createHandler(async () => ({ status, allowed: status !== 'suspended',
      checked_at: new Date().toISOString(), grace_days_remaining: 2, name: 'PRIVATE', amount: 500 }))(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(body.allowed, status !== 'suspended');
    assert.deepEqual(Object.keys(body).sort(), (status === 'grace' ? ['allowed','status','checked_at','grace_days_remaining'] : ['allowed','status','checked_at']).sort());
  });
}
test('HTTP: key inválida, ausente, duplicada e parâmetros extras', async () => {
  const handler = createHandler(() => { throw new Error('must not query'); });
  for (const suffix of ['', '?key=bad', `?key=${key}&key=${key}`, `?key=${key}&client_id=x`]) {
    const r = await handler(request(suffix)); assert.equal(r.status, 400); assert.equal((await r.json()).allowed, undefined);
  }
});
test('HTTP: inexistente e falhas não constituem suspensão', async () => {
  for (const [lookup, expected] of [[async () => null, 404], [async () => { throw Error('network'); }, 503],
    [async () => ({ status: 'suspended', allowed: true }), 503],
    [async () => ({ status: 'grace', allowed: true, checked_at: new Date().toISOString(), grace_days_remaining: -1 }), 503]]) {
    const response = await createHandler(lookup)(request());
    assert.equal(response.status, expected); assert.equal((await response.json()).allowed, undefined);
  }
});
test('HTTP: preflight e método não permitido', async () => {
  const handler = createHandler(async () => { throw Error('must not query'); });
  const options = await handler(request('', 'OPTIONS'));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal((await handler(request('', 'POST'))).status, 405);
});
