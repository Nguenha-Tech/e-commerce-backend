/**
 * Contrato de um provedor de pagamento. O checkout só conhece esta interface:
 * M-Pesa, e-Mola, cartões (Stripe…), PayPal, etc. entram como novas implementações.
 */

export interface InitiatePaymentInput {
  paymentId: string;
  orderNumber: string;
  amount: number; // centavos
  currency: string;
  customer: { email: string; phone?: string | null; name: string };
  /** Configuração NÃO sensível do método (ex.: dados bancários públicos). */
  methodConfig?: Record<string, unknown> | null;
  instructions?: string | null;
}

export type NextAction =
  | { type: 'NONE' }
  | { type: 'REDIRECT'; url: string }
  | { type: 'INSTRUCTIONS'; message: string; data?: Record<string, unknown> }
  | { type: 'MOBILE_PROMPT'; message: string };

export interface InitiatePaymentResult {
  /** PENDING (aguarda ação) ou PROCESSING (gateway já está a processar). Nunca PAID aqui. */
  status: 'PENDING' | 'PROCESSING';
  providerReference?: string;
  nextAction: NextAction;
  /** Resposta do gateway sem dados sensíveis, para PaymentTransaction.rawResponse. */
  raw?: Record<string, unknown>;
}

export interface WebhookEvent {
  /** ID único do evento no provedor (idempotência). */
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.refunded' | 'other';
  providerReference: string;
  amount?: number;
  currency?: string;
  providerTransactionId?: string;
  failureReason?: string;
  raw: Record<string, unknown>;
}

export interface RefundInput {
  refundId: string;
  paymentReference: string | null;
  amount: number; // centavos
  currency: string;
  reason?: string | null;
}

export interface RefundResult {
  /** COMPLETED (devolvido) ou PROCESSING (aguarda confirmação do gateway por webhook). */
  status: 'COMPLETED' | 'PROCESSING';
  providerReference?: string;
  raw?: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly code: string;
  /** true => o pagamento só pode ser confirmado por webhook verificado ou admin. */
  readonly supportsWebhooks: boolean;
  initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  /** Valida a assinatura e normaliza o evento. Deve lançar em caso de assinatura inválida. */
  parseWebhook?(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookEvent;
  /** Reembolso automático pelo gateway. Sem esta função, o reembolso é manual (registado por um admin). */
  refund?(input: RefundInput): Promise<RefundResult>;
}
