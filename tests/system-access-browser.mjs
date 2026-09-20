// PLAYWRIGHT_MODULE pode apontar para uma instalação temporária de playwright.
// Executa somente o modo demo, em servidor local efêmero.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = resolve(import.meta.dirname, '..');
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const content = await readFile(path);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { await route.abort(); return; }
    if (url.pathname.endsWith('/config.js')) {
      await route.fulfill({ contentType: 'text/javascript', body: 'window.SMART_BILLING_CONFIG = {useDemoMode:true};' }); return;
    }
    await route.continue();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/sistemas.html`);
  await page.getByRole('button', { name: 'Novo sistema', exact: true }).click();
  await page.locator('#system-client').selectOption('cli_1');
  await page.locator('#system-name').fill('Portal de teste');
  await page.locator('#system-domain').fill('portal.example.com');
  await page.getByRole('button', { name: 'Salvar sistema' }).click();
  await page.getByRole('heading', { name: 'Portal de teste' }).waitFor();
  await page.getByRole('button', { name: 'Suspender agora' }).click();
  await page.locator('#systems-region .badge', { hasText: 'Suspenso' }).waitFor();
  await page.getByRole('button', { name: 'Liberar manualmente' }).click();
  await page.locator('#systems-region .badge', { hasText: 'Ativo' }).waitFor();
  await page.getByRole('button', { name: 'Voltar para automático' }).click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.locator('#system-grace').fill('5');
  await page.getByRole('button', { name: 'Salvar sistema' }).click();
  await page.getByText('Carência: 5 dias', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Overflow horizontal em mobile');
  await page.goto(`${base}/cliente-historico.html?id=cli_1`);
  await page.locator('#client-systems-region', { hasText: 'Portal de teste' }).waitFor();
  assert.deepEqual(errors, [], 'Erros JavaScript no navegador');
  console.log('PASS: navegador desktop/mobile, cadastro, edição, overrides, histórico e ausência de erros JS');
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}
