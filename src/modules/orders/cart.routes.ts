import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { prisma } from '../../db/client';
import { CART_COOKIE, setCartCookie } from '../auth/auth.cookies';
import { ok } from '../../utils/response';
import { CartService, type CartOwner } from './cart.service';
import { addCartItemBody, applyCouponBody, cartQuery, itemIdParams, updateCartItemBody } from './orders.schemas';

/** /api/v1/cart — funciona para utilizadores autenticados e visitantes (cookie cart_token). */
export const cartRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new CartService();
  const tags = ['Cart'];
  app.addHook('preHandler', app.optionalAuth);

  const ownerOf = (request: FastifyRequest): CartOwner | null => {
    if (request.auth) return { userId: request.auth.userId };
    const token = request.cookies[CART_COOKIE];
    return token ? { guestToken: token } : null;
  };

  app.get('/', { schema: { tags, summary: 'Ver carrinho (subtotal, descontos, cupão, entrega, total)', querystring: cartQuery } }, async (request) => {
    let address = null;
    if (request.query.addressId && request.auth) {
      address = await prisma.address.findFirst({ where: { id: request.query.addressId, userId: request.auth.userId, deletedAt: null } });
    }
    return ok(await service.summary(ownerOf(request), request.auth?.userId ?? null, { shippingMethodCode: request.query.shippingMethod, address }));
  });

  app.post('/items', { schema: { tags, summary: 'Adicionar produto/variante (valida stock)', body: addCartItemBody } }, async (request, reply) => {
    const owner = ownerOf(request);
    const { newGuestToken } = await service.addItem(owner, request.body.variantId, request.body.quantity);
    if (newGuestToken) setCartCookie(reply, newGuestToken);
    const summaryOwner: CartOwner | null = newGuestToken ? { guestToken: newGuestToken } : owner;
    return reply.code(201).send(ok(await service.summary(summaryOwner, request.auth?.userId ?? null), 'Item added to cart'));
  });

  app.patch('/items/:itemId', { schema: { tags, summary: 'Alterar quantidade', params: itemIdParams, body: updateCartItemBody } }, async (request) => {
    await service.updateItem(ownerOf(request), request.params.itemId, request.body.quantity);
    return ok(await service.summary(ownerOf(request), request.auth?.userId ?? null), 'Cart updated');
  });

  app.delete('/items/:itemId', { schema: { tags, summary: 'Remover item', params: itemIdParams } }, async (request) => {
    await service.removeItem(ownerOf(request), request.params.itemId);
    return ok(await service.summary(ownerOf(request), request.auth?.userId ?? null), 'Item removed');
  });

  app.delete('/', { schema: { tags, summary: 'Esvaziar carrinho' } }, async (request) => {
    await service.clear(ownerOf(request));
    return ok(await service.summary(ownerOf(request), request.auth?.userId ?? null), 'Cart cleared');
  });

  app.post('/coupon', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags, summary: 'Aplicar cupão', body: applyCouponBody } }, async (request) => {
    await service.applyCoupon(ownerOf(request), request.auth?.userId ?? null, request.body.code);
    return ok(await service.summary(ownerOf(request), request.auth?.userId ?? null), 'Coupon applied');
  });

  app.delete('/coupon', { schema: { tags, summary: 'Remover cupão' } }, async (request) => {
    await service.removeCoupon(ownerOf(request));
    return ok(await service.summary(ownerOf(request), request.auth?.userId ?? null), 'Coupon removed');
  });
};
