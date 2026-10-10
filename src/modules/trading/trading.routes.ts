import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { money, idemKey } from '../wallet/money.js';
import { INSTRUMENTS } from '../market/instruments.js';
import { openPosition, closePosition, pxAny, pnlOf } from './engine.js';
import { mirrorOpen, mirrorClose } from '../copy/copy.js';

const MIN_TRADE = 1_000n; // $10
const num = z.string().regex(/^\d{1,12}(\.\d{1,10})?$/);
const openBody = z.object({
  symbol: z.enum(INSTRUMENTS.map((i) => i.sym) as [string, ...string[]]),
  side: z.enum(['BUY', 'SELL']),
  amount: money,
  stopLoss: num.optional(),
  takeProfit: num.optional(),
});
const listQ = z.object({ status: z.enum(['OPEN', 'CLOSED']).default('OPEN') });

const view = (position: any) => {
  const current = position.status === 'OPEN' ? pxAny(position.instrument.symbol) : position.exitPrice;
  const pnl = current ? pnlOf(position.side, position.units, position.entryPrice, current) : null;
  return {
    id: position.id,
    sym: position.instrument.symbol,
    name: position.instrument.name,
    asset: position.instrument.assetClass,
    dir: position.side === 'BUY' ? 'long' : 'short',
    side: position.side,
    status: position.status,
    units: position.units.toString(),
    entry: position.entryPrice.toString(),
    cur: current?.toString() ?? null,
    stopLoss: position.stopLoss?.toString() ?? null,
    takeProfit: position.takeProfit?.toString() ?? null,
    pnl: pnl ? pnl.mul(100).toDecimalPlaces(0, 1).toFixed(0) : null,
    pnlPct: pnl ? Number(pnl.div(position.units.mul(position.entryPrice)).mul(100).toFixed(2)) : null,
    copied: !!position.sourceId,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
  };
};

export const tradeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);
  const myAccount = (userId: string) => prisma.account.findFirstOrThrow({ where: { userId, type: 'LIVE' } });

  app.post('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const key = idemKey.parse(req.headers['idempotency-key']);
    const body = openBody.parse(req.body);
    if (body.amount < MIN_TRADE)
      return reply.code(400).send({ error: 'BELOW_MIN', min: MIN_TRADE.toString() });
    const account = await myAccount(req.user.sub);
    const position = await openPosition({
      accountId: account.id,
      sym: body.symbol,
      side: body.side,
      amount: body.amount,
      sl: body.stopLoss,
      tp: body.takeProfit,
      key: `${account.id}:${key}`,
    });
    await audit(req.user.sub, 'trade.open', req.ip, { id: position.id, sym: body.symbol, side: body.side });
    mirrorOpen(req.user.sub, position).catch((error) => app.log.error(error));
    return reply.code(201).send(view(position));
  });

  app.get('/', async (req) => {
    const { status } = listQ.parse(req.query);
    const account = await myAccount(req.user.sub);
    const positions = await prisma.position.findMany({
      where: { accountId: account.id, status },
      include: { instrument: true },
      orderBy: status === 'OPEN' ? { openedAt: 'desc' } : { closedAt: 'desc' },
      take: 100,
    });
    return { items: positions.map(view) };
  });

  app.post('/:id/close', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const account = await myAccount(req.user.sub);
    const result = await closePosition(id, account.id);
    mirrorClose(id).catch((error) => app.log.error(error));
    await audit(req.user.sub, 'trade.close', req.ip, { id });
    return result;
  });
};