import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import fp from 'fastify-plugin';
import { env } from '../config/env';
import { createStorage, LocalStorageProvider } from '../modules/uploads/storage';

export default fp(
  async (app) => {
    const storage = createStorage();
    app.decorate('storage', storage);

    await app.register(multipart, {
      limits: {
        fileSize: Math.floor(env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024),
        files: env.UPLOAD_MAX_FILES,
        fields: 20,
        fieldSize: 1024,
        parts: env.UPLOAD_MAX_FILES + 20,
      },
      throwFileSizeLimit: false, // tratamos `truncated` com erro próprio
    });

    // Storage local: servir ficheiros (em produção, preferir CDN/Nginx à frente).
    if (storage instanceof LocalStorageProvider) {
      await mkdir(storage.rootDir, { recursive: true });
      await app.register(fastifyStatic, {
        root: storage.rootDir,
        prefix: '/uploads/',
        decorateReply: false,
        index: false,
        list: false,
        dotfiles: 'deny',
        maxAge: '30d',
        immutable: true,
      });
    }
  },
  { name: 'storage' },
);
