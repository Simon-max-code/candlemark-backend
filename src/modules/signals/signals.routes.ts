import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../lib/prisma.js';

export const signalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => ({
    items: await prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  }));
};
