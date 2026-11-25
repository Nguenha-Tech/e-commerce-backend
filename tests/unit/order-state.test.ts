import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from '../../src/modules/orders/order-state';

describe('máquina de estados do pedido', () => {
  it('permite o fluxo normal', () => {
    const flow = ['PENDING', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'REFUNDED'] as const;
    for (let i = 0; i < flow.length - 1; i++) expect(canTransition(flow[i]!, flow[i + 1]!), `${flow[i]} -> ${flow[i + 1]}`).toBe(true);
  });

  it('impede transições inválidas', () => {
    expect(canTransition('PENDING', 'SHIPPED')).toBe(false);
    expect(canTransition('DELIVERED', 'CANCELLED')).toBe(false);
    expect(canTransition('SHIPPED', 'CANCELLED')).toBe(false);
    expect(canTransition('REFUNDED', 'PENDING')).toBe(false);
    expect(() => assertTransition('CANCELLED', 'CONFIRMED')).toThrow(/Cannot change order status/);
  });
});
