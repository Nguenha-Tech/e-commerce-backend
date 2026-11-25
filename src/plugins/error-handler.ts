import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { Prisma } from '../db/client';
import { AppError } from '../utils/errors';

interface ErrorBody {
  success: false;
  message: string;
  errorCode: string;
  details?: unknown;
  timestamp: string;
  path: string;
  requestId: string;
}

function send(reply: FastifyReply, request: FastifyRequest, status: number, errorCode: string, message: string, details?: unknown) {
  const body: ErrorBody = {
    success: false,
    message,
    errorCode,
    ...(details !== undefined ? { details } : {}),
    timestamp: new Date().toISOString(),
    path: request.url.split('?')[0] ?? request.url,
    requestId: String(request.id),
  };
  return reply.status(status).send(body);
}

const zodDetails = (err: ZodError) => err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));

export default fp(
  async (app) => {
    app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
      if (error instanceof AppError) {
        if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
        return send(reply, request, error.statusCode, error.errorCode, error.message, error.details);
      }

      // Validação de body/query/params (fastify-type-provider-zod)
      const fe = error as FastifyError;
      if (fe.validation) {
        const details = fe.validation.map((v) => ({
          path: [fe.validationContext, ...String(v.instancePath ?? '').split('/').filter(Boolean)].join('.'),
          message: v.message,
        }));
        return send(reply, request, 400, 'VALIDATION_ERROR', 'Invalid request data', details);
      }
      if (error instanceof ZodError) {
        return send(reply, request, 400, 'VALIDATION_ERROR', 'Invalid request data', zodDetails(error));
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          return send(reply, request, 409, 'RESOURCE_CONFLICT', 'A resource with the same unique value already exists', {
            target: error.meta?.target,
          });
        }
        if (error.code === 'P2025') return send(reply, request, 404, 'RESOURCE_NOT_FOUND', 'Resource not found');
        if (error.code === 'P2003') return send(reply, request, 409, 'RESOURCE_IN_USE', 'Related resource constraint failed');
      }

      const status = fe.statusCode ?? 500;
      if (status === 429) return send(reply, request, 429, 'TOO_MANY_REQUESTS', 'Too many requests, please try again later');
      if (status === 413 || fe.code === 'FST_REQ_FILE_TOO_LARGE')
        return send(reply, request, 413, 'PAYLOAD_TOO_LARGE', 'File or payload too large');
      if (fe.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE')
        return send(reply, request, 406, 'INVALID_CONTENT_TYPE', 'Request is not multipart');
      if (status < 500) return send(reply, request, status, fe.code ?? 'BAD_REQUEST', error.message);

      request.log.error({ err: error }, 'unhandled error');
      return send(
        reply,
        request,
        500,
        'INTERNAL_SERVER_ERROR',
        env.isProd ? 'An unexpected error occurred' : error.message,
      );
    });

    app.setNotFoundHandler((request, reply) =>
      send(reply, request, 404, 'ROUTE_NOT_FOUND', `Route ${request.method} ${request.url.split('?')[0]} not found`),
    );
  },
  { name: 'error-handler' },
);
