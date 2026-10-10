import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { postEntry } from '../wallet/ledger.js';
import { INSTRUMENTS } from '../market/instruments.js';
import { quote, feed } from '../market/feed.js';
import { notify } from '../../lib/notify.js';
import { mirrorClose } from '../copy/copy.js';
import { usd } from '../../lib/notify.js';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;
const dp = new Map(INSTRUMENTS.map((i) => [i.sym, i.dp]));
const err = (code: string, statusCode = 400) => Object.assign(new Error(code), { statusCode });

export const px = (sym: string): Dec | null => {
  const q = quote(sym);
  return q ? new D(q.price.toFixed(dp.get(sym)!)) : null;
};

export const pnlOf = (side: 'BUY' | 'SELL', units: Dec, entry: Dec, cur: Dec) =>
  units.mul(side === 'BUY' ? cur.minus(entry) : entry.minus(cur));

export async function openPosition(a: {
  accountId: string; sym: string; side: 'BUY' | 'SELL'; amount: bigint;
  sl?: string; tp?: string; key: string; sourceId?: string;
}) {
  const price = px(a.sym);
  if (!price) throw err('PRICE_UNAVAILABLE', 503);
  const buy = a.side === 'BUY';
  if (a.sl && (buy ? new D(a.sl).gte(price) : new D(a.sl).lte(price))) throw err('BAD_STOP_LOSS');
  if (a.tp && (buy ? new D(a.tp).lte(price) : new D(a.tp).gte(price))) throw err('BAD_TAKE_PROFIT');

  return prisma.$transaction(async (tx) => {
    const key = `pos-open:${a.key}`;
    const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: key } });
    if (existing) return tx.position.findUniqueOrThrow({ where: { id: existing.refId! }, include: { instrument: true } });

    if ((await tx.position.count({ where: { accountId: a.accountId, status: 'OPEN' } })) >= 50)
      throw err('TOO_MANY_POSITIONS');
    const instrument = await tx.instrument.findUniqueOrThrow({ where: { symbol: a.sym } });
    const units = new D(a.amount.toString()).div(100).div(price).toDecimalPlaces(10);
    const position = await tx.position.create({
      data: {
        accountId: a.accountId,
        instrumentId: instrument.id,
        side: a.side,
        units,
        entryPrice: price,
        stopLoss: a.sl,
        takeProfit: a.tp,
        sourceId: a.sourceId,
      },
      include: { instrument: true },
    });
    await postEntry(tx, {
      accountId: a.accountId,
      amount: -a.amount,
      type: 'TRADE_PNL',
      key,
      refType: 'Position',
      refId: position.id,
    });
    return position;
  });
}

export async function closePosition(id: string, accountId?: string) {
  const position = await prisma.position.findUnique({ where: { id }, include: { instrument: true } });
  if (!position || (accountId && position.accountId !== accountId)) throw err('NOT_FOUND', 404);
  if (position.status !== 'OPEN') throw err('ALREADY_CLOSED', 409);
  const exit = px(position.instrument.symbol);
  if (!exit) throw err('PRICE_UNAVAILABLE', 503);

  return prisma.$transaction(async (tx) => {
    const result = await tx.position.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'CLOSED', exitPrice: exit, closedAt: new Date() },
    });
    if (!result.count) throw err('ALREADY_CLOSED', 409);
    const opened = await tx.ledgerEntry.findFirstOrThrow({ where: { refType: 'Position', refId: id, amount: { lt: 0n } } });
    const invested = -opened.amount;
    const pnl = BigInt(pnlOf(position.side, position.units, position.entryPrice, exit)
      .mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toFixed(0));
    let payout = invested + pnl;
    if (payout < 0n) payout = 0n;
    await postEntry(tx, {
      accountId: position.accountId,
      amount: payout,
      type: 'TRADE_PNL',
      key: `pos-close:${id}`,
      refType: 'Position',
      refId: id,
    });
    return { id, exitPrice: exit.toString(), invested: invested.toString(), pnl: pnl.toString(), payout: payout.toString() };
  });
}

let busy = false;
export function startTriggers() {
  feed.on('tick', async () => {
    if (busy) return;
    busy = true;
    try {
      const positions = await prisma.position.findMany({
        where: { status: 'OPEN', OR: [{ stopLoss: { not: null } }, { takeProfit: { not: null } }] },
        include: { instrument: true },
      });
      for (const position of positions) {
        const current = px(position.instrument.symbol);
        if (!current) continue;
        const long = position.side === 'BUY';
        const stopLoss = position.stopLoss && (long ? current.lte(position.stopLoss) : current.gte(position.stopLoss));
        const takeProfit = position.takeProfit && (long ? current.gte(position.takeProfit) : current.lte(position.takeProfit));
        if (stopLoss || takeProfit) {
          const result = await closePosition(position.id).catch(() => null);
          if (result) {
            mirrorClose(position.id).catch(() => {});
            const account = await prisma.account.findUnique({ where: { id: position.accountId }, select: { userId: true } });
            if (account) void notify(account.userId, `${position.instrument.symbol} ${stopLoss ? 'stop loss' : 'take profit'} hit`, `Position closed at ${result.exitPrice}. Result: $${usd(BigInt(result.pnl))}.`, true).catch(() => {});
          }
        }
      }
    } finally {
      busy = false;
    }
  });
}