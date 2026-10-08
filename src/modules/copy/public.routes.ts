import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../lib/prisma.js';

export const publicMentorRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const rows = await prisma.mentor.findMany({
      where: { verified: true },
      include: {
        user: { select: { name: true } },
        _count: { select: { copiers: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return {
      items: rows.map((m: any) => ({
        id: m.id,
        handle: m.handle,
        name: m.displayName ?? m.user.name,
        tag: m.tag,
        bio: m.bio,
        risk: m.riskScore,
        fee: m.feeMinor.toString(),
        copiers: m.stats?.copiers ?? m._count.copiers,
        stats: m.stats ?? {},
      })),
    };
  });
};