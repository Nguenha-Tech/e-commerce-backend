import { prisma, WhatsAppSource } from '../../../../db/client';
import type { AuditContext } from '../../../../utils/audit';
import { Errors } from '../../../../utils/errors';
import { PUBLIC_STATUSES } from '../../products.service';
import { getActivePromotions, resolvePrice } from '../../price-resolver';
import { clickStats, recordClick } from './whatsapp.analytics';
import { loadWhatsAppConfig, updateWhatsAppConfig, type UpdateWhatsAppInput, type WhatsAppConfigRow } from './whatsapp.config';
import { frontendLinks } from '../../../../utils/frontend-links';
import {
  buildMessage,
  buildWaMeLink,
  isWithinBusinessHours,
  toInternationalNumber,
  type BusinessHours,
  type ProductContext,
} from './whatsapp.message-builder';

/**
 * WhatsAppService — orquestra configuração, mensagem e analytics.
 * Hoje gera links wa.me; no futuro, um provider "business_api" pode enviar mensagens
 * oficiais sem alterar os endpoints públicos.
 */

export interface LinkRequest {
  source: WhatsAppSource;
  productId?: string;
  variantId?: string;
  orderNumber?: string;
}

export interface Visitor {
  userId?: string;
  visitorHash: string;
}

export class WhatsAppService {
  private async enabledConfig(): Promise<WhatsAppConfigRow> {
    const cfg = await loadWhatsAppConfig();
    if (!cfg || !cfg.isEnabled || !cfg.phoneNumber) throw Errors.notFound('WhatsApp integration', 'WHATSAPP_DISABLED');
    return cfg;
  }

  /** Configuração pública para o botão (sem nada sensível). */
  async publicConfig() {
    const cfg = await loadWhatsAppConfig();
    if (!cfg || !cfg.isEnabled) return { enabled: false as const };
    const number = toInternationalNumber(cfg.countryCode, cfg.phoneNumber);
    const open = isWithinBusinessHours(cfg.businessHours as BusinessHours);
    return {
      enabled: true as const,
      buttonText: cfg.buttonText,
      buttonPosition: cfg.buttonPosition,
      isOpen: open,
      welcomeMessage: cfg.welcomeMessage,
      awayMessage: open ? null : cfg.awayMessage,
      businessHours: cfg.businessHours,
      /** Link genérico (página inicial / contacto). Para contexto de produto use POST /whatsapp/link. */
      link: buildWaMeLink(number, buildMessage({ source: WhatsAppSource.HOMEPAGE, defaultMessage: cfg.defaultMessage, contextMessages: cfg.contextMessages as Record<string, string> })),
      alternatives: ((cfg.alternativeNumbers as Array<{ label: string; countryCode: string; phoneNumber: string }>) ?? []).map((a) => ({
        label: a.label,
        link: buildWaMeLink(toInternationalNumber(a.countryCode, a.phoneNumber)),
      })),
    };
  }

  private async productContext(productId: string, variantId?: string): Promise<{ ctx: ProductContext; variantId?: string }> {
    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null, status: { in: PUBLIC_STATUSES } },
      select: {
        id: true, name: true, slug: true, sku: true, categoryId: true, brandId: true, currency: true,
        variants: {
          where: { deletedAt: null, isActive: true },
          select: { id: true, sku: true, name: true, price: true, originalPrice: true, promoPrice: true, promoStartsAt: true, promoEndsAt: true, isDefault: true },
          orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
        },
      },
    });
    if (!product) throw Errors.notFound('Product');
    const variant = variantId ? product.variants.find((v) => v.id === variantId) : product.variants[0];
    if (variantId && !variant) throw Errors.unprocessable('VARIANT_NOT_IN_PRODUCT', 'Variant does not belong to this product');
    // Preço calculado pela mesma fonte do checkout (inclui promoções ativas).
    const price = variant ? resolvePrice(variant, product, await getActivePromotions()).unitPrice : null;
    const showVariant = variant && product.variants.length > 1;
    return {
      variantId: variant?.id,
      ctx: {
        name: product.name,
        sku: variant?.sku ?? product.sku,
        variantName: showVariant ? variant.name : null,
        price,
        currency: product.currency,
        url: frontendLinks.product(product.slug),
      },
    };
  }

  /** Gera o link contextualizado e regista o clique (analytics). */
  async createLink(input: LinkRequest, visitor: Visitor) {
    const cfg = await this.enabledConfig();
    if (input.source === WhatsAppSource.PRODUCT && !input.productId) throw Errors.badRequest('PRODUCT_REQUIRED', 'productId is required for PRODUCT source');

    let product: ProductContext | undefined;
    let variantId = input.variantId;
    if (input.productId) {
      const res = await this.productContext(input.productId, input.variantId);
      product = res.ctx;
      variantId = res.variantId;
    }
    const open = isWithinBusinessHours(cfg.businessHours as BusinessHours);
    const message = buildMessage({
      source: input.source,
      defaultMessage: cfg.defaultMessage,
      contextMessages: cfg.contextMessages as Record<string, string>,
      product,
      orderNumber: input.orderNumber,
    });
    const url = buildWaMeLink(toInternationalNumber(cfg.countryCode, cfg.phoneNumber), message);

    await recordClick({ source: input.source, productId: input.productId, variantId, userId: visitor.userId, visitorHash: visitor.visitorHash });
    return { url, message, isOpen: open, awayMessage: open ? null : cfg.awayMessage };
  }

  // ------------------------------------------------------------------ admin
  async adminGet() {
    const cfg = await loadWhatsAppConfig();
    return cfg ? { ...cfg, preview: buildWaMeLink(toInternationalNumber(cfg.countryCode, cfg.phoneNumber), cfg.defaultMessage) } : null;
  }

  async adminUpdate(ctx: AuditContext, input: UpdateWhatsAppInput) {
    if (input.contextMessages) {
      // Atualização parcial das mensagens por contexto (não apaga as restantes).
      const current = await loadWhatsAppConfig();
      input = { ...input, contextMessages: { ...((current?.contextMessages as object) ?? {}), ...input.contextMessages } };
    }
    if (input.isEnabled) {
      const current = await loadWhatsAppConfig();
      if (!(input.phoneNumber ?? current?.phoneNumber)) throw Errors.badRequest('WHATSAPP_NUMBER_REQUIRED', 'Configure the phone number before enabling');
    }
    await updateWhatsAppConfig(ctx, input);
    return this.adminGet();
  }

  analytics(from: Date, to: Date) {
    return clickStats(from, to);
  }
}
