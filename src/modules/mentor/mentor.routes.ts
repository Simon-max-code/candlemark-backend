import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { balanceOf } from '../wallet/ledger.js';

async function mentorOnly(req: FastifyRequest, reply: FastifyReply) {
  const m = await prisma.mentor.findUnique({ where: { userId: req.user.sub } });
  const u = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { status: true } });
  if (!m || !m.verified || u?.status !== 'ACTIVE') reply.code(403).send({ error: 'NOT_A_MENTOR' });
}

export const mentorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);
  app.addHook('preHandler', mentorOnly);

  app.get('/overview', async (req) => {
    const m = await prisma.mentor.findUniqueOrThrow({ where: { userId: req.user.sub }, include: { user: { select: { name: true } } } });
    const acc = await prisma.account.findFirstOrThrow({ where: { userId: req.user.sub, type: 'LIVE' } });
    const [balance, copies, rows] = await Promise.all([
      balanceOf(acc.id),
      prisma.copyRelation.aggregate({ where: { mentorId: m.id, status: 'ACTIVE' }, _count: true, _sum: { allocationMinor: true } }),
      prisma.ledgerEntry.findMany({ where: { accountId: acc.id, refType: 'Position', type: 'TRADE_PNL' }, select: { refId: true, amount: true, idempotencyKey: true } }),
    ]);
    const sum = new Map<string, bigint>(); const closed = new Set<string>();
    for (const r of rows) {
      sum.set(r.refId!, (sum.get(r.refId!) ?? 0n) + r.amount);
      if (r.idempotencyKey.startsWith('pos-close:')) closed.add(r.refId!);
    }
    let wins = 0, pnl = 0n;
    for (const id of closed) { const s = sum.get(id)!; pnl += s; if (s > 0n) wins++; }
    return {
      name: m.displayName ?? m.user.name, handle: m.handle,
      balance: balance.toString(), copiers: copies._count, allocated: (copies._sum.allocationMinor ?? 0n).toString(),
      trades: closed.size, winRate: closed.size ? Math.round((wins / closed.size) * 100) : null, pnl: pnl.toString(),
    };
  });
};
