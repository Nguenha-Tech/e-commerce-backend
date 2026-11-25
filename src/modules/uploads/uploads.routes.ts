import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { ok } from '../../utils/response';
import { UPLOAD_FOLDERS, UploadsService } from './uploads.service';

/** Upload genérico de imagens (banners, categorias, marcas…). Imagens de produto: /admin/products/:id/images. */
export const uploadsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new UploadsService(app.storage);

  app.post(
    '/images',
    {
      preHandler: [app.authenticate, app.authorize(PERMISSIONS.UPLOADS_CREATE)],
      schema: {
        tags: ['Admin · Uploads'],
        summary: 'Upload de imagens (multipart/form-data, campo "file", múltiplos permitidos)',
        consumes: ['multipart/form-data'],
        querystring: z.object({ folder: z.enum(UPLOAD_FOLDERS).default('misc') }),
      },
    },
    async (request, reply) => {
      const { files } = await service.uploadFromRequest(request, request.query.folder);
      return reply.code(201).send(ok(files, 'Images uploaded successfully'));
    },
  );
};
