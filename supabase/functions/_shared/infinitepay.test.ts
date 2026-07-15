// ============================================================================
// Testes das funções puras de _shared/infinitepay.ts.
// Rodar com: deno test supabase/functions/_shared/infinitepay.test.ts
// Não faz nenhuma chamada de rede nem pagamento real — apenas valida a
// lógica pura (conversão de valores, normalização de telefone, validação de
// payloads e de domínio do checkout).
// ============================================================================

import { assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  reaisToCents,
  centsToReais,
  normalizePhoneBR,
  mapCaptureMethod,
  isValidInfinitePayCheckoutUrl,
  isValidWebhookPayload,
  isValidCheckPaymentPayload,
  isValidUuid,
} from './infinitepay.ts';

// ---------------- reaisToCents / centsToReais ----------------
Deno.test('reaisToCents converte valor em reais para centavos corretamente', () => {
  assertEquals(reaisToCents(348.5), 34850);
  assertEquals(reaisToCents(10), 1000);
  assertEquals(reaisToCents(0.1), 10);
});

Deno.test('reaisToCents rejeita valores inválidos (zero, negativo, NaN)', () => {
  assertThrows(() => reaisToCents(0));
  assertThrows(() => reaisToCents(-5));
  assertThrows(() => reaisToCents(NaN));
});

Deno.test('centsToReais converte centavos para reais corretamente', () => {
  assertEquals(centsToReais(34850), 348.5);
  assertEquals(centsToReais(1000), 10);
});

// ---------------- normalizePhoneBR ----------------
Deno.test('normalizePhoneBR adiciona +55 quando ausente', () => {
  assertEquals(normalizePhoneBR('11987654321'), '+5511987654321');
});

Deno.test('normalizePhoneBR mantém +55 quando já presente', () => {
  assertEquals(normalizePhoneBR('5511987654321'), '+5511987654321');
});

Deno.test('normalizePhoneBR remove formatação (parênteses, espaços, traço)', () => {
  assertEquals(normalizePhoneBR('(11) 98765-4321'), '+5511987654321');
});

Deno.test('normalizePhoneBR retorna null para telefone vazio/ausente', () => {
  assertEquals(normalizePhoneBR(null), null);
  assertEquals(normalizePhoneBR(''), null);
});

// ---------------- mapCaptureMethod ----------------
Deno.test('mapCaptureMethod mapeia pix e credit_card para o enum do banco', () => {
  assertEquals(mapCaptureMethod('pix'), 'pix');
  assertEquals(mapCaptureMethod('credit_card'), 'cartao');
});

Deno.test('mapCaptureMethod retorna null para método desconhecido', () => {
  assertEquals(mapCaptureMethod('boleto'), null);
  assertEquals(mapCaptureMethod(undefined), null);
});

// ---------------- isValidInfinitePayCheckoutUrl ----------------
Deno.test('isValidInfinitePayCheckoutUrl aceita URL https do domínio oficial', () => {
  assertEquals(isValidInfinitePayCheckoutUrl('https://checkout.infinitepay.com.br/abc123'), true);
});

Deno.test('isValidInfinitePayCheckoutUrl rejeita http (não https)', () => {
  assertEquals(isValidInfinitePayCheckoutUrl('http://checkout.infinitepay.com.br/abc123'), false);
});

Deno.test('isValidInfinitePayCheckoutUrl rejeita domínio diferente (phishing/typo)', () => {
  assertEquals(isValidInfinitePayCheckoutUrl('https://checkout.infinitepay.com.br.evil.com/x'), false);
  assertEquals(isValidInfinitePayCheckoutUrl('https://evil.com/checkout.infinitepay.com.br'), false);
});

Deno.test('isValidInfinitePayCheckoutUrl rejeita URL ausente/malformada', () => {
  assertEquals(isValidInfinitePayCheckoutUrl(null), false);
  assertEquals(isValidInfinitePayCheckoutUrl(''), false);
  assertEquals(isValidInfinitePayCheckoutUrl('not a url'), false);
});

// ---------------- isValidWebhookPayload ----------------
Deno.test('isValidWebhookPayload aceita payload completo válido (pix)', () => {
  assertEquals(isValidWebhookPayload({
    invoice_slug: 'abc123',
    amount: 34850,
    paid_amount: 34850,
    installments: 1,
    capture_method: 'pix',
    transaction_nsu: 'uuid-1',
    order_nsu: 'COB-000001',
    receipt_url: 'https://x.com/r',
  }), true);
});

Deno.test('isValidWebhookPayload aceita payload completo válido (cartão parcelado)', () => {
  assertEquals(isValidWebhookPayload({
    invoice_slug: 'abc123',
    amount: 34850,
    paid_amount: 34850,
    installments: 3,
    capture_method: 'credit_card',
    transaction_nsu: 'uuid-1',
    order_nsu: 'COB-000001',
  }), true);
});

Deno.test('isValidWebhookPayload rejeita payload sem transaction_nsu', () => {
  assertEquals(isValidWebhookPayload({
    invoice_slug: 'abc123',
    amount: 34850,
    paid_amount: 34850,
    installments: 1,
    capture_method: 'pix',
    order_nsu: 'COB-000001',
  }), false);
});

Deno.test('isValidWebhookPayload rejeita payload com amount inválido', () => {
  assertEquals(isValidWebhookPayload({
    invoice_slug: 'abc123',
    amount: 0,
    paid_amount: 0,
    installments: 1,
    capture_method: 'pix',
    transaction_nsu: 'uuid-1',
    order_nsu: 'COB-000001',
  }), false);
});

Deno.test('isValidWebhookPayload rejeita corpo vazio/null', () => {
  assertEquals(isValidWebhookPayload(null), false);
  assertEquals(isValidWebhookPayload({}), false);
});

// ---------------- isValidCheckPaymentPayload / isValidUuid ----------------
Deno.test('isValidCheckPaymentPayload aceita payload público válido', () => {
  assertEquals(isValidCheckPaymentPayload({
    token: '123e4567-e89b-12d3-a456-426614174000',
    order_nsu: 'COB-000001',
    transaction_nsu: 'uuid-1',
    slug: 'abc123',
  }), true);
});

Deno.test('isValidCheckPaymentPayload rejeita token que não é uuid', () => {
  assertEquals(isValidCheckPaymentPayload({
    token: 'not-a-uuid',
    order_nsu: 'COB-000001',
    transaction_nsu: 'uuid-1',
    slug: 'abc123',
  }), false);
});

Deno.test('isValidCheckPaymentPayload rejeita campos ausentes', () => {
  assertEquals(isValidCheckPaymentPayload({ token: '123e4567-e89b-12d3-a456-426614174000' }), false);
});

Deno.test('isValidUuid valida formato uuid corretamente', () => {
  assertEquals(isValidUuid('123e4567-e89b-12d3-a456-426614174000'), true);
  assertEquals(isValidUuid('abc'), false);
  assertEquals(isValidUuid(123), false);
});
