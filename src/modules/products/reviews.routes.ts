import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { PERMISSIONS } from '../../config/permissions';
import { auditContext } from '../../utils/audit';
import { paginationQuery } from '../../utils/pagination';
import { ok } from '../../utils/response';
import { UploadsService } from '../uploads/uploads.service';
import { QuestionsService } from './questions.service';
import {
  adminQuestionsQuery,
  adminReviewsQuery,
  answerQuestionBody,
  createQuestionBody,
  createReviewBody,
  idParams,
  listReviewsQuery,
  moderateReviewBody,
  productIdParams,
  questionStatusBody,
  replyBody,
  reportReviewBody,
  updateReviewBody,
} from './reviews.schemas';
import { ReviewsService } from './reviews.service';

const questions = new QuestionsService();

/**
 * /api/v1 — avaliações e perguntas.
 * Públicos: GET /products/:id/reviews, GET /products/:id/questions.
 * Cliente:  /products/:id/reviews (POST), /reviews/*, /products/:id/questions (POST), /questions/*.
 */
export const reviewsRoutes: FastifyPluginAsyncZod = async (app) => {
  const reviews = new ReviewsService(app.storage);
  const uploads = new UploadsService(app.storage);
  const rt = ['Reviews'];
  const qt = ['Questions'];

  app.get('/products/:id/reviews', { schema: { tags: rt, summary: 'Avaliações aprovadas + resumo (média e distribuição)', params: productIdParams, querystring: listReviewsQuery } }, async (request) => {
    const { items, meta } = await reviews.listForProduct(request.params.id, request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/products/:id/questions', { schema: { tags: qt, summary: 'Perguntas publicadas', params: productIdParams, querystring: paginationQuery } }, async (request) => {
    const { items, meta } = await questions.listForProduct(request.params.id, request.query);
    return ok(items, 'OK', meta);
  });

  await app.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('preHandler', app.authenticate);

    scope.post(
      '/products/:id/reviews',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { tags: rt, summary: 'Avaliar produto (só compras entregues; 1 por produto)', params: productIdParams, body: createReviewBody },
      },
      async (request, reply) => reply.code(201).send(ok(await reviews.create(request.auth!.userId, request.params.id, request.body), 'Review submitted successfully')),
    );

    scope.post(
      '/reviews/images',
      {
        config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
        schema: { tags: rt, summary: 'Upload de fotos da avaliação (multipart, campo "file"); devolve storageKey para usar no POST da avaliação', consumes: ['multipart/form-data'] },
      },
      async (request, reply) => {
        await reviews.assertCanUploadPhotos();
        const { files } = await uploads.uploadFromRequest(request, 'reviews');
        return reply.code(201).send(ok(files.map((f) => ({ storageKey: f.storageKey, url: f.url, thumbnailUrl: f.thumbnailUrl })), 'Images uploaded successfully'));
      },
    );

    scope.get('/reviews/me', { schema: { tags: rt, summary: 'As minhas avaliações', querystring: paginationQuery } }, async (request) => {
      const { items, meta } = await reviews.listMine(request.auth!.userId, request.query);
      return ok(items, 'OK', meta);
    });

    scope.get('/reviews/eligible', { schema: { tags: rt, summary: 'Produtos recebidos que ainda posso avaliar' } }, async (request) => ok(await reviews.eligible(request.auth!.userId)));

    scope.patch('/reviews/:id', { schema: { tags: rt, summary: 'Editar a minha avaliação', params: idParams, body: updateReviewBody } }, async (request) =>
      ok(await reviews.updateMine(request.auth!.userId, request.params.id, request.body), 'Review updated successfully'),
    );

    scope.delete('/reviews/:id', { schema: { tags: rt, summary: 'Apagar a minha avaliação', params: idParams } }, async (request) => {
      await reviews.deleteMine(request.auth!.userId, request.params.id);
      return ok(null, 'Review deleted successfully');
    });

    scope.post('/reviews/:id/report', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { tags: rt, summary: 'Denunciar avaliação', params: idParams, body: reportReviewBody } }, async (request) => {
      await reviews.report(request.auth!.userId, request.params.id, request.body.reason);
      return ok(null, 'Review reported');
    });

    scope.post(
      '/products/:id/questions',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: qt, summary: 'Fazer pergunta sobre o produto', params: productIdParams, body: createQuestionBody } },
      async (request, reply) => reply.code(201).send(ok(await questions.ask(request.auth!.userId, request.params.id, request.body.question), 'Question submitted successfully')),
    );

    scope.get('/questions/me', { schema: { tags: qt, summary: 'As minhas perguntas', querystring: paginationQuery } }, async (request) => {
      const { items, meta } = await questions.listMine(request.auth!.userId, request.query);
      return ok(items, 'OK', meta);
    });

    scope.delete('/questions/:id', { schema: { tags: qt, summary: 'Apagar pergunta (só sem resposta)', params: idParams } }, async (request) => {
      await questions.deleteMine(request.auth!.userId, request.params.id);
      return ok(null, 'Question deleted successfully');
    });
  });
};

/** /api/v1/admin — moderação de avaliações e perguntas. */
export const reviewsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const reviews = new ReviewsService(app.storage);
  const P = PERMISSIONS;
  const rt = ['Admin · Reviews & Questions'];
  app.addHook('preHandler', app.authenticate);

  app.get('/reviews', { preHandler: app.authorize(P.REVIEWS_MODERATE), schema: { tags: rt, summary: 'Listar avaliações (estado, denunciadas, sem resposta…)', querystring: adminReviewsQuery } }, async (request) => {
    const { items, meta } = await reviews.adminList(request.query);
    return ok(items, 'OK', meta);
  });
  app.patch('/reviews/:id/status', { preHandler: app.authorize(P.REVIEWS_MODERATE), schema: { tags: rt, summary: 'Aprovar / ocultar / rejeitar', params: idParams, body: moderateReviewBody } }, async (request) =>
    ok(await reviews.moderate(auditContext(request), request.params.id, request.body.status, request.body.note), 'Review updated successfully'),
  );
  app.post('/reviews/:id/reply', { preHandler: app.authorize(P.REVIEWS_MODERATE), schema: { tags: rt, summary: 'Responder à avaliação', params: idParams, body: replyBody } }, async (request) =>
    ok(await reviews.reply(auditContext(request), request.params.id, request.body.reply), 'Reply saved successfully'),
  );
  app.delete('/reviews/:id', { preHandler: app.authorize(P.REVIEWS_MODERATE), schema: { tags: rt, summary: 'Apagar avaliação (abuso / spam)', params: idParams } }, async (request) => {
    await reviews.remove(auditContext(request), request.params.id);
    return ok(null, 'Review deleted successfully');
  });

  app.get('/questions', { preHandler: app.authorize(P.QUESTIONS_MODERATE), schema: { tags: rt, summary: 'Listar perguntas (sem resposta primeiro)', querystring: adminQuestionsQuery } }, async (request) => {
    const { items, meta } = await questions.adminList(request.query);
    return ok(items, 'OK', meta);
  });
  app.post('/questions/:id/answer', { preHandler: app.authorize(P.QUESTIONS_MODERATE), schema: { tags: rt, summary: 'Responder (e publicar)', params: idParams, body: answerQuestionBody } }, async (request) =>
    ok(await questions.answer(auditContext(request), request.params.id, request.body.answer, request.body.publish), 'Answer saved successfully'),
  );
  app.patch('/questions/:id/status', { preHandler: app.authorize(P.QUESTIONS_MODERATE), schema: { tags: rt, summary: 'Publicar / ocultar pergunta', params: idParams, body: questionStatusBody } }, async (request) =>
    ok(await questions.setStatus(auditContext(request), request.params.id, request.body.status), 'Question updated successfully'),
  );
  app.delete('/questions/:id', { preHandler: app.authorize(P.QUESTIONS_MODERATE), schema: { tags: rt, summary: 'Apagar pergunta', params: idParams } }, async (request) => {
    await questions.remove(auditContext(request), request.params.id);
    return ok(null, 'Question deleted successfully');
  });
};
