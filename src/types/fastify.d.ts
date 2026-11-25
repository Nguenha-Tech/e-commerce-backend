import '@fastify/jwt';
import 'fastify';
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Permission } from '../config/permissions';
import type { DbClient } from '../db/client';
import type { StorageProvider } from '../modules/uploads/storage/storage.provider';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  roles: string[];
  /** Maior nível hierárquico entre as roles do utilizador. */
  roleLevel: number;
  permissions: Set<string>;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: DbClient;
    storage: StorageProvider;
    /** Exige utilizador autenticado com sessão válida. */
    authenticate: preHandlerAsyncHookHandler;
    /** Carrega o utilizador se existir token válido; nunca falha. */
    optionalAuth: preHandlerAsyncHookHandler;
    /** Exige TODAS as permissões indicadas (usar depois de authenticate). */
    authorize: (...permissions: Permission[]) => preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    auth?: AuthContext;
  }
}
