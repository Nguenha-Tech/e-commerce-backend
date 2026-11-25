import { describe, expect, it } from 'vitest';
import { buildMessage, buildWaMeLink, isWithinBusinessHours, toInternationalNumber } from '../../src/modules/products/storefront/whatsapp/whatsapp.message-builder';

describe('WhatsAppMessageBuilder', () => {
  const product = { name: 'Samsung Galaxy S25 Ultra', sku: 'SAM-S25U-256', variantName: 'Preto 256GB', price: 7_500_000, currency: 'MZN', url: 'https://loja.co.mz/produtos/s25' };

  it('mensagem de produto inclui nome, variante, SKU, preço e link', () => {
    const msg = buildMessage({ source: 'PRODUCT', defaultMessage: 'Olá', product });
    expect(msg).toContain('Olá! Tenho interesse no produto:');
    expect(msg).toContain('Samsung Galaxy S25 Ultra');
    expect(msg).toContain('Variante: Preto 256GB');
    expect(msg).toContain('SKU: SAM-S25U-256');
    expect(msg).toMatch(/Preço: 75\.000 MZN/);
    expect(msg).toContain('https://loja.co.mz/produtos/s25');
  });

  it('suporta marcadores configurados pelo admin e garante SKU/link', () => {
    const msg = buildMessage({ source: 'PRODUCT', defaultMessage: 'Olá', contextMessages: { PRODUCT: 'Quero o {productName} ({variant})' }, product });
    expect(msg.startsWith('Quero o Samsung Galaxy S25 Ultra (Preto 256GB)')).toBe(true);
    expect(msg).toContain('SKU: SAM-S25U-256');
    expect(msg).toContain(product.url);
  });

  it('mensagens por contexto (carrinho, página inicial)', () => {
    expect(buildMessage({ source: 'CART', defaultMessage: 'x' })).toBe('Olá! Gostaria de obter ajuda com o meu carrinho.');
    expect(buildMessage({ source: 'HOMEPAGE', defaultMessage: 'x', contextMessages: { HOMEPAGE: 'Bom dia!' } })).toBe('Bom dia!');
  });

  it('número internacional sem +, espaços, zeros à esquerda ou indicativo duplicado', () => {
    expect(toInternationalNumber('258', '84 123 4567')).toBe('258841234567');
    expect(toInternationalNumber('+258', '0841234567')).toBe('258841234567');
    expect(toInternationalNumber('258', '258841234567')).toBe('258841234567');
  });

  it('link wa.me com texto codificado', () => {
    expect(buildWaMeLink('258841234567', 'Olá & obrigado')).toBe('https://wa.me/258841234567?text=Ol%C3%A1%20%26%20obrigado');
  });

  it('horário de atendimento no fuso da loja', () => {
    const hours = { timezone: 'Africa/Maputo', days: { mon: ['08:00', '18:00'] as [string, string] } };
    // 2026-10-05 é segunda-feira. 09:00 UTC = 11:00 em Maputo.
    expect(isWithinBusinessHours(hours, new Date('2026-10-05T09:00:00Z'))).toBe(true);
    expect(isWithinBusinessHours(hours, new Date('2026-10-05T17:30:00Z'))).toBe(false); // 19:30 local
    expect(isWithinBusinessHours(hours, new Date('2026-10-04T09:00:00Z'))).toBe(false); // domingo
    expect(isWithinBusinessHours({}, new Date())).toBe(true);
  });
});
