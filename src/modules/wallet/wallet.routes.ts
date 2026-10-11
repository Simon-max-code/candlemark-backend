import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { balanceOf } from './ledger.js';
import { tradingAccount } from '../tier/tier.js';

const q = z.object({
  type: z.enum(['DEMO_FUNDING', 'DEPOSIT', 'WITHDRAWAL', 'TRADE_PNL', 'COPY_FEE', 'ADJUSTMENT']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
const balanceQ = z.object({ acct: z.literal('trading').optional() });

export const walletRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  const myAccount = (userId: string) =>
    prisma.account.findFirstOrThrow({ where: { userId, type: 'LIVE' } });

  app.get('/balance', async (req) => {
    const { acct } = balanceQ.parse(req.query);
    const a = acct ? await tradingAccount(req.user.sub) : await myAccount(req.user.sub);
    return { accountId: a.id, type: a.type, currency: a.currency, available: (await balanceOf(a.id)).toString() };
  });

  app.get('/ledger', async (req) => {
    const { type, limit, cursor } = q.parse(req.query);
    const a = await myAccount(req.user.sub);
    const rows = await prisma.ledgerEntry.findMany({
      where: { accountId: a.id, ...(type && { type }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map((r) => ({
        id: r.id,
        type: r.type,
        amount: r.amount.toString(),
        refType: r.refType,
        refId: r.refId,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  });
};