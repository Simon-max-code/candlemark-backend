import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId: req.user.sub }, orderBy: { createdAt: 'desc' }, take: limit }),
      prisma.notification.count({ where: { userId: req.user.sub, readAt: null } }),
    ]);
    return { unread, items };
  });

  app.post('/read-all', async (req) => {
    await prisma.notification.updateMany({ where: { userId: req.user.sub, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  });

  app.post('/:id/read', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    await prisma.notification.updateMany({ where: { id, userId: req.user.sub, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  });
};