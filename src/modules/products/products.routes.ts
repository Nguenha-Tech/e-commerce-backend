import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../../utils/pagination';
import { ok } from '../../utils/response';
import { BrandsService } from './brands.service';
import { idParams, listProductsQuery, relatedQuery, slugParams } from './products.schemas';
import { ProductsService } from './products.service';

const products = new ProductsService();
const brands = new BrandsService();

/** /api/v1/products — catálogo público. */
export const productsRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Catalog'];

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Listar / pesquisar / filtrar / ordenar produtos',
        description:
          'Ex.: `?search=samsung 256gb&category=smartphones&brand=samsung,apple&minPrice=1000000&inStock=true&color=Preto&spec=RAM:8GB&sort=price_asc&page=1&limit=20`. Preços em centavos.',
        querystring: listProductsQuery,
      },
    },
    async (request) => {
      const { items, meta } = await products.list(request.query);
      return ok(items, 'OK', meta);
    },
  );

  app.get('/filters', { schema: { tags, summary: 'Facetas disponíveis (marcas, preço, especificações) para os filtros atuais', querystring: listProductsQuery } }, async (request) =>
    ok(await products.facets(request.query)),
  );

  app.get('/featured', { schema: { tags, summary: 'Produtos em destaque', querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) }) } }, async (request) => {
    const { items } = await products.featured(request.query.limit);
    return ok(items);
  });

  app.get('/on-sale', { schema: { tags, summary: 'Produtos em promoção (maior desconto primeiro)', querystring: paginationQuery } }, async (request) => {
    const { items, meta } = await products.onSale(request.query.page, request.query.limit);
    return ok(items, 'OK', meta);
  });

  app.get('/best-sellers', { schema: { tags, summary: 'Mais vendidos', querystring: paginationQuery } }, async (request) => {
    const { items, meta } = await products.bestSellers(request.query.page, request.query.limit);
    return ok(items, 'OK', meta);
  });

  app.get('/slug/:slug', { schema: { tags, summary: 'Detalhe por slug', params: slugParams } }, async (request) =>
    ok(await products.getByIdOrSlug({ slug: request.params.slug })),
  );

  app.get('/:id', { schema: { tags, summary: 'Detalhe por ID', params: idParams } }, async (request) => ok(await products.getByIdOrSlug({ id: request.params.id })));

  app.get(
    '/:id/related',
    { schema: { tags, summary: 'Relacionados: SIMILAR, RECOMMENDED, ACCESSORY, FREQUENTLY_BOUGHT_TOGETHER, ALSO_BOUGHT', params: idParams, querystring: relatedQuery } },
    async (request) => ok(await products.related(request.params.id, request.query.type, request.query.limit)),
  );
};

/** /api/v1/brands — público. */
export const brandsRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Catalog'];
  app.get('/', { schema: { tags, summary: 'Listar marcas ativas' } }, async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return ok(await brands.listPublic());
  });
  app.get('/:slug', { schema: { tags, summary: 'Marca por slug', params: z.object({ slug: z.string().max(100) }) } }, async (request) =>
    ok(await brands.getBySlug(request.params.slug)),
  );
};
