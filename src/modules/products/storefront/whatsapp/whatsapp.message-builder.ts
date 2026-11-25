import { WhatsAppSource } from '../../../../db/client';
import { formatMoney } from '../../../../utils/money';

/**
 * WhatsAppMessageBuilder — funções puras (testáveis) que montam a mensagem e o link.
 * Nunca incluem dados pessoais do cliente: apenas dados públicos do produto/página.
 */

export interface ProductContext {
  name: string;
  sku: string;
  variantName?: string | null;
  price?: number | null;
  currency?: string;
  url?: string;
}

export const DEFAULT_CONTEXT_MESSAGES: Record<WhatsAppSource, string> = {
  HOMEPAGE: 'Olá! Gostaria de saber mais sobre os produtos da loja.',
  PRODUCT: 'Olá! Tenho interesse no produto:',
  CART: 'Olá! Gostaria de obter ajuda com o meu carrinho.',
  CHECKOUT: 'Olá! Preciso de ajuda para finalizar a minha compra.',
  SUPPORT: 'Olá! Preciso de apoio do suporte.',
  CONTACT: 'Olá! Gostaria de entrar em contacto com a loja.',
};

export interface BuildMessageInput {
  source: WhatsAppSource;
  defaultMessage: string;
  contextMessages?: Partial<Record<WhatsAppSource, string>>;
  product?: ProductContext;
  /** Ex.: número do pedido — só quando o próprio cliente o fornece (não é dado sensível). */
  orderNumber?: string;
}

const MAX_MESSAGE = 1000;

const PLACEHOLDER = /\{(productName|sku|variant|price|url|orderNumber)\}/g;

/**
 * Mensagens configuradas podem usar marcadores: {productName}, {sku}, {variant}, {price},
 * {url}, {orderNumber}. Sem marcadores, os dados do produto são acrescentados automaticamente.
 */
export function buildMessage(input: BuildMessageInput): string {
  const template = input.contextMessages?.[input.source]?.trim() || DEFAULT_CONTEXT_MESSAGES[input.source] || input.defaultMessage;
  const p = input.product;
  const values: Record<string, string> = {
    productName: p?.name ?? '',
    sku: p?.sku ?? '',
    variant: p?.variantName ?? '',
    price: p?.price != null ? formatMoney(p.price, p.currency) : '',
    url: p?.url ?? '',
    orderNumber: input.orderNumber ?? '',
  };

  if (PLACEHOLDER.test(template)) {
    PLACEHOLDER.lastIndex = 0;
    let text = template.replace(PLACEHOLDER, (_m, key: string) => values[key] ?? '');
    // Garante sempre o SKU e o link do produto (identificação sem ambiguidade para a loja).
    if (p && !template.includes('{sku}')) text += `\nSKU: ${p.sku}${p.variantName && !template.includes('{variant}') ? ` (${p.variantName})` : ''}`;
    if (values.price && !template.includes('{price}')) text += `\nPreço: ${values.price}`;
    if (p?.url && !template.includes('{url}')) text += `\n${p.url}`;
    return text.replace(/\n{3,}/g, '\n\n').slice(0, MAX_MESSAGE);
  }

  const lines: string[] = [template];
  if (input.source === WhatsAppSource.PRODUCT && p) {
    lines.push(p.name);
    if (p.variantName) lines.push(`Variante: ${p.variantName}`);
    lines.push(`SKU: ${p.sku}`);
    if (values.price) lines.push(`Preço: ${values.price}`);
    if (p.url) lines.push(p.url);
    lines.push('', 'Gostaria de saber mais informações sobre disponibilidade e preço.');
  }
  if (input.orderNumber && (input.source === WhatsAppSource.SUPPORT || input.source === WhatsAppSource.CHECKOUT)) {
    lines.push(`Pedido: ${input.orderNumber}`);
  }
  return lines.join('\n').slice(0, MAX_MESSAGE);
}

/** Apenas dígitos, em formato internacional sem "+" (exigido por wa.me). */
export function toInternationalNumber(countryCode: string, phoneNumber: string): string {
  const cc = countryCode.replace(/\D/g, '');
  let number = phoneNumber.replace(/\D/g, '');
  if (number.startsWith(cc) && number.length > 9) number = number.slice(cc.length);
  return `${cc}${number.replace(/^0+/, '')}`;
}

/**
 * Link universal: no telemóvel/tablet abre a app WhatsApp; no desktop abre WhatsApp Desktop
 * (se instalado) ou WhatsApp Web.
 */
export function buildWaMeLink(internationalNumber: string, message?: string): string {
  const base = `https://wa.me/${internationalNumber}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

export type BusinessHours = { timezone?: string; days?: Partial<Record<string, [string, string] | null>> };

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Está dentro do horário de atendimento? Sem horário configurado => sempre aberto. */
export function isWithinBusinessHours(hours: BusinessHours, now = new Date()): boolean {
  if (!hours.days || Object.keys(hours.days).length === 0) return true;
  const tz = hours.timezone ?? 'Africa/Maputo';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')!.value.toLowerCase().slice(0, 3);
  const hhmm = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
  const slot = hours.days[weekday as (typeof DAY_KEYS)[number]];
  if (!slot) return false;
  return hhmm >= slot[0] && hhmm < slot[1];
}

export { DAY_KEYS };
