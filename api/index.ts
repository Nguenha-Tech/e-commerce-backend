import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Entrada serverless da Vercel. A app Fastify é construída uma vez por instância
 * (reaproveitada entre pedidos) e recebe os pedidos HTTP diretamente.
 * vercel.json reescreve todos os caminhos (/api/v1/..., /health, /docs, /uploads) para esta função.
 */
type App = Awaited<ReturnType<typeof import('../src/app').buildApp>>;

let appPromise: Promise<App> | null = null;

async function getApp(): Promise<App> {
  appPromise ??= (async () => {
    // Import dinâmico: um erro de configuração (env) é apanhado em baixo em vez de matar a função.
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();
    return app;
  })().catch((err) => {
    appPromise = null; // tentar de novo no próximo pedido
    throw err;
  });
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await getApp();
    app.server.emit('request', req, res);
  } catch (err) {
    console.error('Failed to start app:', err);
    const issues = (err as { name?: string; issues?: string[] })?.name === 'EnvConfigError' ? (err as { issues: string[] }).issues : undefined;
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    // Só nomes de variáveis e motivos — nunca valores nem stack.
    res.end(JSON.stringify({ error: { code: 'SERVER_MISCONFIGURED', message: 'Server failed to start', ...(issues ? { env: issues } : {}) } }));
  }
}
