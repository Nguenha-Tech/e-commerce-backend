import { describe, expect, it } from 'vitest';
import { assertReturnTransition, ReturnsService } from '../../src/modules/orders/returns.service';

describe('devoluções', () => {
  it('transições válidas', () => {
    expect(() => assertReturnTransition('REQUESTED', 'APPROVED')).not.toThrow();
    expect(() => assertReturnTransition('APPROVED', 'RECEIVED')).not.toThrow();
    expect(() => assertReturnTransition('RECEIVED', 'REFUNDED')).not.toThrow();
  });

  it('transições inválidas', () => {
    expect(() => assertReturnTransition('REQUESTED', 'RECEIVED')).toThrow(/Cannot change return/);
    expect(() => assertReturnTransition('REFUNDED', 'CANCELLED')).toThrow();
    expect(() => assertReturnTransition('REJECTED', 'APPROVED')).toThrow();
  });

  it('valor de reembolso proporcional ao que foi pago pelas unidades devolvidas', () => {
    expect(
      ReturnsService.defaultRefundAmount([
        { quantity: 1, orderItem: { quantity: 3, lineTotal: 270_000 } }, // 1 de 3 (com cupão aplicado)
        { quantity: 2, orderItem: { quantity: 2, lineTotal: 50_000 } },
      ]),
    ).toBe(140_000);
  });
});
