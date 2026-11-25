/**
 * Erro de domínio com código estável para o frontend (errorCode) e status HTTP.
 * Os serviços lançam AppError; o handler global converte para o formato padrão.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const toCode = (resource: string) => resource.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toUpperCase();

export const Errors = {
  badRequest: (errorCode: string, message: string, details?: unknown) => new AppError(400, errorCode, message, details),
  unauthorized: (message = 'Authentication required', errorCode = 'UNAUTHORIZED') => new AppError(401, errorCode, message),
  forbidden: (message = 'You do not have permission to perform this action', errorCode = 'FORBIDDEN', details?: unknown) =>
    new AppError(403, errorCode, message, details),
  notFound: (resource: string, errorCode?: string) => new AppError(404, errorCode ?? `${toCode(resource)}_NOT_FOUND`, `${resource} not found`),
  conflict: (errorCode: string, message: string, details?: unknown) => new AppError(409, errorCode, message, details),
  unprocessable: (errorCode: string, message: string, details?: unknown) => new AppError(422, errorCode, message, details),
  locked: (errorCode: string, message: string, details?: unknown) => new AppError(423, errorCode, message, details),
};
