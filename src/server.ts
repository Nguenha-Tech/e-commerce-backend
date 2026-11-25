import { buildApp } from './app';
import { env } from './config/env';

async function main() {
  const app = await buildApp();

  // Encerramento gracioso: termina pedidos em curso, fecha a BD e os jobs.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandled rejection'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    if (env.DOCS_ENABLED) app.log.info(`API docs: ${env.API_URL}/docs`);
  } catch (err) {
    app.log.fatal({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
