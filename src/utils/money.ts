/** Valores monetários são inteiros na unidade mínima (centavos). */

export const percentOf = (amount: number, percent: number) => Math.floor((amount * percent) / 100);

export const discountPercent = (original: number, final: number) =>
  original > 0 && final < original ? Math.round(((original - final) / original) * 100) : 0;

/**
 * 7500000 -> "75.000 MZN"; 74234 -> "742,34 MZN" (textos, notificações, WhatsApp).
 * Mesmo formato do frontend: milhares com ".", decimais com "," só quando existem.
 */
export function formatMoney(amount: number, currency = 'MZN'): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(Math.round(amount));
  const units = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = abs % 100;
  return `${sign}${units}${cents ? `,${String(cents).padStart(2, '0')}` : ''} ${currency}`;
}
