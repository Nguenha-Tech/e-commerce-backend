import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { PERMISSIONS } from '../../config/permissions';
import { auditContext } from '../../utils/audit';
import { paginationQuery } from '../../utils/pagination';
import { ok } from '../../utils/response';
import { UploadsService } from '../uploads/uploads.service';
import { BrandsService } from './brands.service';
import { InventoryService } from './inventory.service';
import { ProductsAdminService } from './products.admin.service';
import {
  adminListProductsQuery,
  changeStatusBody,
  createBrandBody,
  createMovementBody,
  createProductBody,
  createVariantBody,
  idParams,
  inventorySettingsBody,
  listInventoryQuery,
  productImageParams,
  reorderImagesBody,
  setRelationsBody,
  updateBrandBody,
  updateImageBody,
  updateProductBody,
  updateVariantBody,
  variantIdParams,
} from './products.schemas';

const P = PERMISSIONS;

/** /api/v1/admin — produtos, variantes, imagens, marcas e inventário. */
export const productsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ProductsAdminService(new UploadsService(app.storage));
  const brands = new BrandsService();
  const inventory = new InventoryService();
  const tags = ['Admin · Catalog'];
  app.addHook('preHandler', app.authenticate);

  // ---------------------------------------------------------------- produtos
  app.get('/products', { preHandler: app.authorize(P.PRODUCTS_READ), schema: { tags, summary: 'Listar produtos (todos os estados)', querystring: adminListProductsQuery } }, async (request) => {
    const { items, meta } = await service.list(request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/products/:id', { preHandler: app.authorize(P.PRODUCTS_READ), schema: { tags, summary: 'Detalhe completo (custos, stock, variantes)', params: idParams } }, async (request) =>
    ok(await service.get(request.params.id)),
  );

  app.post(
    '/products',
    {
      preHandler: app.authorize(P.PRODUCTS_CREATE),
      schema: {
        tags,
        summary: 'Criar produto (DRAFT por omissão)',
        description: 'Produto simples: envie `pricing`/`stock`/`physical`. Produto com variantes: envie `variants[]` (cada uma com SKU, preço e stock próprios).',
        body: createProductBody,
      },
    },
    async (request, reply) => reply.code(201).send(ok(await service.create(auditContext(request), request.body), 'Product created successfully')),
  );

  app.patch('/products/:id', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Editar produto', params: idParams, body: updateProductBody } }, async (request) =>
    ok(await service.update(auditContext(request), request.params.id, request.body), 'Product updated successfully'),
  );

  app.post('/products/:id/publish', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Publicar (valida imagens, preço, categoria)', params: idParams } }, async (request) =>
    ok(await service.changeStatus(auditContext(request), request.params.id, 'ACTIVE'), 'Product published successfully'),
  );

  app.patch('/products/:id/status', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Alterar estado (DRAFT, ACTIVE, INACTIVE, DISCONTINUED)', params: idParams, body: changeStatusBody } }, async (request) =>
    ok(await service.changeStatus(auditContext(request), request.params.id, request.body.status), 'Product status updated'),
  );

  app.delete('/products/:id', { preHandler: app.authorize(P.PRODUCTS_DELETE), schema: { tags, summary: 'Remover produto (soft delete)', params: idParams } }, async (request) => {
    await service.remove(auditContext(request), request.params.id);
    return ok(null, 'Product deleted successfully');
  });

  app.put('/products/:id/relations', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Definir produtos relacionados de um tipo', params: idParams, body: setRelationsBody } }, async (request) =>
    ok(await service.setRelations(auditContext(request), request.params.id, request.body.type, request.body.productIds), 'Relations updated'),
  );

  // ---------------------------------------------------------------- variantes
  app.post('/products/:id/variants', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Adicionar variante', params: idParams, body: createVariantBody } }, async (request, reply) =>
    reply.code(201).send(ok(await service.addVariant(auditContext(request), request.params.id, request.body), 'Variant created successfully')),
  );

  app.patch('/variants/:variantId', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Editar variante (preço, opções, físico)', params: variantIdParams, body: updateVariantBody } }, async (request) =>
    ok(await service.updateVariant(auditContext(request), request.params.variantId, request.body), 'Variant updated successfully'),
  );

  app.delete('/variants/:variantId', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Remover variante', params: variantIdParams } }, async (request) => {
    await service.removeVariant(auditContext(request), request.params.variantId);
    return ok(null, 'Variant deleted successfully');
  });

  // ---------------------------------------------------------------- imagens
  app.post(
    '/products/:id/images',
    {
      preHandler: app.authorize(P.PRODUCTS_UPDATE, P.UPLOADS_CREATE),
      schema: { tags, summary: 'Upload de imagens do produto (multipart: file[], altText?, variantId?)', consumes: ['multipart/form-data'], params: idParams },
    },
    async (request, reply) => reply.code(201).send(ok(await service.addImages(auditContext(request), request.params.id, request), 'Images uploaded successfully')),
  );

  app.patch('/products/:id/images/:imageId', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Editar imagem (alt, principal, variante, ordem)', params: productImageParams, body: updateImageBody } }, async (request) =>
    ok(await service.updateImage(auditContext(request), request.params.id, request.params.imageId, request.body), 'Image updated'),
  );

  app.put('/products/:id/images/order', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Reordenar galeria', params: idParams, body: reorderImagesBody } }, async (request) =>
    ok(await service.reorderImages(request.params.id, request.body.imageIds), 'Images reordered'),
  );

  app.delete('/products/:id/images/:imageId', { preHandler: app.authorize(P.PRODUCTS_UPDATE), schema: { tags, summary: 'Remover imagem', params: productImageParams } }, async (request) => {
    await service.removeImage(auditContext(request), request.params.id, request.params.imageId);
    return ok(null, 'Image deleted');
  });

  // ---------------------------------------------------------------- marcas
  app.get('/brands', { preHandler: app.authorize(P.BRANDS_MANAGE), schema: { tags, summary: 'Listar marcas' } }, async () => ok(await brands.adminList()));
  app.post('/brands', { preHandler: app.authorize(P.BRANDS_MANAGE), schema: { tags, summary: 'Criar marca', body: createBrandBody } }, async (request, reply) =>
    reply.code(201).send(ok(await brands.create(auditContext(request), request.body), 'Brand created successfully')),
  );
  app.patch('/brands/:id', { preHandler: app.authorize(P.BRANDS_MANAGE), schema: { tags, summary: 'Editar marca', params: idParams, body: updateBrandBody } }, async (request) =>
    ok(await brands.update(auditContext(request), request.params.id, request.body), 'Brand updated successfully'),
  );
  app.delete('/brands/:id', { preHandler: app.authorize(P.BRANDS_MANAGE), schema: { tags, summary: 'Remover marca', params: idParams } }, async (request) => {
    await brands.remove(auditContext(request), request.params.id);
    return ok(null, 'Brand deleted successfully');
  });

  // ---------------------------------------------------------------- inventário
  const invTags = ['Admin · Inventory'];
  app.get('/inventory', { preHandler: app.authorize(P.INVENTORY_READ), schema: { tags: invTags, summary: 'Stock por variante (lowStock=true para alertas)', querystring: listInventoryQuery } }, async (request) => {
    const { items, meta } = await inventory.list(request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/inventory/:variantId/movements', { preHandler: app.authorize(P.INVENTORY_READ), schema: { tags: invTags, summary: 'Histórico de movimentos', params: variantIdParams, querystring: paginationQuery } }, async (request) => {
    const { items, meta } = await inventory.movements(request.params.variantId, request.query);
    return ok(items, 'OK', meta);
  });

  app.post(
    '/inventory/:variantId/movements',
    { preHandler: app.authorize(P.INVENTORY_MANAGE), schema: { tags: invTags, summary: 'Entrada/saída/ajuste/danificado/devolução', params: variantIdParams, body: createMovementBody } },
    async (request, reply) => reply.code(201).send(ok(await inventory.createMovement(auditContext(request), request.params.variantId, request.body), 'Stock movement recorded')),
  );

  app.patch('/inventory/:variantId', { preHandler: app.authorize(P.INVENTORY_MANAGE), schema: { tags: invTags, summary: 'Stock mínimo/máximo e localização', params: variantIdParams, body: inventorySettingsBody } }, async (request) =>
    ok(await inventory.updateSettings(auditContext(request), request.params.variantId, request.body), 'Inventory settings updated'),
  );
};
