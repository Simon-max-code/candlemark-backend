import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { tierOf } from '../tier/tier.js';

const body = z.object({
  handle: z.string().regex(/^[a-z0-9_]{3,30}$/),
  bio: z.string().trim().min(20).max(500),
  tag: z.string().trim().max(80).optional(),
});

export const mentorApplyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const m = await prisma.mentor.findUnique({ where: { userId: req.user.sub }, select: { verified: true } });
    return { status: !m ? 'NONE' : m.verified ? 'APPROVED' : 'PENDING' };
  });

  app.post('/', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = body.parse(req.body);
    if ((await tierOf(req.user.sub)).tier < 5) return reply.code(403).send({ error: 'TIER_REQUIRED' });
    try {
      await prisma.mentor.create({ data: { userId: req.user.sub, handle: b.handle, bio: b.bio, tag: b.tag, verified: false } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return reply.code(409).send({ error: 'ALREADY_APPLIED_OR_HANDLE_TAKEN' });
      throw error;
    }
    await audit(req.user.sub, 'mentor.apply', req.ip, { handle: b.handle });
    return reply.code(201).send({ status: 'PENDING' });
  });
};
