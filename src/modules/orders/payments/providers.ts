import { randomUUID } from 'node:crypto';
import { env } from '../../../config/env';
import { hmacSha256Hex, safeEqual } from '../../../utils/crypto';
import { Errors } from '../../../utils/errors';
import { formatMoney } from '../../../utils/money';
import type { InitiatePaymentInput, InitiatePaymentResult, PaymentProvider, RefundInput, RefundResult, WebhookEvent } from './payment.provider';

/** Pagamento na entrega: o pedido é confirmado logo; o pagamento fica PENDING até à entrega. */
export class CashOnDeliveryProvider implements PaymentProvider {
  readonly code = 'cod';
  readonly supportsWebhooks = false;
  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    return {
      status: 'PENDING',
      nextAction: { type: 'INSTRUCTIONS', message: `Pague ${formatMoney(input.amount, input.currency)} no momento da entrega.` },
    };
  }
}

/** Transferência bancária: o cliente transfere com a referência; um admin confirma (auditado). */
export class ManualTransferProvider implements PaymentProvider {
  readonly code = 'manual';
  readonly supportsWebhooks = false;
  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    return {
      status: 'PENDING',
      providerReference: `TRF-${input.orderNumber}`,
      nextAction: {
        type: 'INSTRUCTIONS',
        message: input.instructions ?? `Transfira ${formatMoney(input.amount, input.currency)} usando a referência ${input.orderNumber}.`,
        data: { reference: input.orderNumber, amount: input.amount, currency: input.currency, ...(input.methodConfig ?? {}) },
      },
    };
  }
}

/**
 * Gateway simulado (desenvolvimento/testes) com o mesmo fluxo de um real:
 * initiate -> PROCESSING -> webhook assinado (HMAC-SHA256 do corpo bruto no header x-mock-signature).
 * Serve de modelo para M-Pesa / cartões.
 */
export class MockGatewayProvider implements PaymentProvider {
  readonly code = 'mock';
  readonly supportsWebhooks = true;
  constructor(private readonly secret: string | undefined = env.PAYMENT_MOCK_WEBHOOK_SECRET) {}

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const reference = `mock_${randomUUID()}`;
    return {
      status: 'PROCESSING',
      providerReference: reference,
      nextAction: { type: 'MOBILE_PROMPT', message: 'Confirme o pagamento no seu telemóvel.' },
      raw: { reference, amount: input.amount, currency: input.currency },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return { status: 'COMPLETED', providerReference: `mock_refund_${randomUUID()}`, raw: { amount: input.amount, currency: input.currency } };
  }

  sign(rawBody: Buffer | string): string {
    if (!this.secret) throw new Error('PAYMENT_MOCK_WEBHOOK_SECRET not configured');
    return hmacSha256Hex(this.secret, rawBody);
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookEvent {
    if (!this.secret) throw Errors.unauthorized('Webhook secret not configured', 'WEBHOOK_NOT_CONFIGURED');
    const signature = headers['x-mock-signature'];
    if (typeof signature !== 'string' || !safeEqual(signature, this.sign(rawBody))) {
      throw Errors.unauthorized('Invalid webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw Errors.badRequest('INVALID_WEBHOOK_PAYLOAD', 'Invalid JSON');
    }
    const data = (body.data ?? {}) as Record<string, unknown>;
    if (typeof body.id !== 'string' || typeof data.reference !== 'string') {
      throw Errors.badRequest('INVALID_WEBHOOK_PAYLOAD', 'Missing event id or reference');
    }
    const type = body.type === 'payment.succeeded' || body.type === 'payment.failed' || body.type === 'payment.refunded' ? body.type : 'other';
    return {
      eventId: body.id,
      type,
      providerReference: data.reference,
      amount: typeof data.amount === 'number' ? data.amount : undefined,
      currency: typeof data.currency === 'string' ? data.currency : undefined,
      providerTransactionId: typeof data.transactionId === 'string' ? data.transactionId : undefined,
      failureReason: typeof data.reason === 'string' ? data.reason : undefined,
      raw: body,
    };
  }
}

const registry = new Map<string, PaymentProvider>();

export function listPaymentProviders() {
  return [...registry.values()].map((p) => ({ code: p.code, supportsWebhooks: p.supportsWebhooks, supportsAutomaticRefunds: typeof p.refund === 'function' }));
}

export function registerPaymentProvider(provider: PaymentProvider) {
  registry.set(provider.code, provider);
}

export function getPaymentProvider(code: string): PaymentProvider {
  const provider = registry.get(code);
  if (!provider) throw Errors.unprocessable('PAYMENT_PROVIDER_UNAVAILABLE', `Payment provider "${code}" is not available`);
  return provider;
}

registerPaymentProvider(new CashOnDeliveryProvider());
registerPaymentProvider(new ManualTransferProvider());
registerPaymentProvider(new MockGatewayProvider());
