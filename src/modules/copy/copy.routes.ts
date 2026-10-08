import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { money } from '../wallet/money.js';
import { balanceOf } from '../wallet/ledger.js';
import { chargeFee } from './copy.js';

const startBody = z.object({ allocation: money });
const id = z.object({ id: z.string().min(1).max(40) });
const period = () => new Date().toISOString().slice(0, 7);

const mentorView = (m: any) => ({
  id: m.id,
  handle: m.handle,
  name: m.displayName ?? m.user.name,
  tag: m.tag,
  bio: m.bio,
  risk: m.riskScore,
  fee: m.feeMinor.toString(),
  copiers: m.stats?.copiers ?? m._count.copiers,
  stats: m.stats ?? {},
  verified: m.verified,
});

export const copyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);
  const myAccount = (userId: string) => prisma.account.findFirstOrThrow({ where: { userId, type: 'LIVE' } });

  app.get('/mentors', async () => {
    const rows = await prisma.mentor.findMany({
      where: { verified: true },
      include: {
        user: { select: { name: true } },
        _count: { select: { copiers: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return { items: rows.map(mentorView) };
  });

  app.get('/', async (req) => {
    const account = await myAccount(req.user.sub);
    const rows = await prisma.copyRelation.findMany({
      where: { accountId: account.id, status: { not: 'STOPPED' } },
      include: { mentor: { include: { user: { select: { name: true } } } } },
    });
    return {
      items: rows.map((copy) => ({
        id: copy.id,
        mentorId: copy.mentorId,
        name: copy.mentor.displayName ?? copy.mentor.user.name,
        handle: copy.mentor.handle,
        allocation: copy.allocationMinor.toString(),
        status: copy.status,
      })),
    };
  });

  app.post('/mentors/:id/copy', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id: mentorId } = id.parse(req.params);
    const { allocation } = startBody.parse(req.body);
    if (allocation < 5_000n) return reply.code(400).send({ error: 'BELOW_MIN', min: '5000' });
    const account = await myAccount(req.user.sub);
    const mentor = await prisma.mentor.findFirst({ where: { id: mentorId, verified: true } });
    if (!mentor) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (mentor.userId === req.user.sub) return reply.code(400).send({ error: 'SELF_COPY' });
    if ((await balanceOf(account.id)) < allocation + mentor.feeMinor)
      return reply.code(400).send({ error: 'INSUFFICIENT_FUNDS' });

    const copy = await prisma.copyRelation.upsert({
      where: { accountId_mentorId: { accountId: account.id, mentorId } },
      update: { allocationMinor: allocation, status: 'ACTIVE' },
      create: { accountId: account.id, mentorId, allocationMinor: allocation },
    });
    await chargeFee(account.id, mentorId, mentor.feeMinor, period());
    await audit(req.user.sub, 'copy.start', req.ip, { mentorId, allocation: allocation.toString() });
    return reply.code(201).send({ id: copy.id, status: copy.status });
  });

  const setStatus = (status: 'PAUSED' | 'STOPPED' | 'ACTIVE') => async (req: any, reply: any) => {
    const { id: copyId } = id.parse(req.params);
    const account = await myAccount(req.user.sub);
    const result = await prisma.copyRelation.updateMany({
      where: { id: copyId, accountId: account.id },
      data: { status },
    });
    if (!result.count) return reply.code(404).send({ error: 'NOT_FOUND' });
    await audit(req.user.sub, `copy.${status.toLowerCase()}`, req.ip, { id: copyId });
    return { status };
  };
  app.post('/:id/pause', setStatus('PAUSED'));
  app.post('/:id/resume', setStatus('ACTIVE'));
  app.post('/:id/stop', setStatus('STOPPED'));
};