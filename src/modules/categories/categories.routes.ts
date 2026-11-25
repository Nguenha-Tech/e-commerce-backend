import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { PERMISSIONS } from '../../config/permissions';
import { auditContext } from '../../utils/audit';
import { ok } from '../../utils/response';
import { createCategoryBody, idParams, slugParams, updateCategoryBody } from './categories.schemas';
import { CategoriesService } from './categories.service';

const service = new CategoriesService();

/** /api/v1/categories — público. */
export const categoriesRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Catalog'];

  app.get('/', { schema: { tags, summary: 'Árvore de categorias ativas' } }, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return ok(await service.tree());
  });

  app.get('/:slug', { schema: { tags, summary: 'Categoria por slug (com breadcrumb e subcategorias)', params: slugParams } }, async (request) =>
    ok(await service.getBySlug(request.params.slug)),
  );
};

/** /api/v1/admin/categories */
export const categoriesAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Admin · Catalog'];
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.authorize(PERMISSIONS.CATEGORIES_MANAGE));

  app.get('/', { schema: { tags, summary: 'Todas as categorias (inclui inativas) com contagem de produtos' } }, async () => ok(await service.adminList()));
  app.get('/tree', { schema: { tags, summary: 'Árvore completa (inclui inativas)' } }, async () => ok(await service.tree(false)));

  app.post('/', { schema: { tags, summary: 'Criar categoria', body: createCategoryBody } }, async (request, reply) =>
    reply.code(201).send(ok(await service.create(auditContext(request), request.body), 'Category created successfully')),
  );

  app.patch('/:id', { schema: { tags, summary: 'Editar categoria', params: idParams, body: updateCategoryBody } }, async (request) =>
    ok(await service.update(auditContext(request), request.params.id, request.body), 'Category updated successfully'),
  );

  app.delete('/:id', { schema: { tags, summary: 'Remover categoria (soft delete)', params: idParams } }, async (request) => {
    await service.remove(auditContext(request), request.params.id);
    return ok(null, 'Category deleted successfully');
  });
};
