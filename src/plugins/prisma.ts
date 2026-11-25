import fp from 'fastify-plugin';
import { prisma } from '../db/client';

export default fp(
  async (app) => {
    app.decorate('prisma', prisma);
    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  },
  { name: 'prisma' },
);
