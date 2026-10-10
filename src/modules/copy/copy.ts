import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { postEntry, balanceOf } from '../wallet/ledger.js';
import { openPosition, closePosition } from '../trading/engine.js';
import { notify, usd } from '../../lib/notify.js';
import { pipInfo } from '../market/instruments.js';

// Called after a mentor opens a position.
export async function mirrorOpen(mentorUserId: string, pos: {
  id: string;
  side: 'BUY' | 'SELL';
  stopLoss: { toString(): string } | null;
  takeProfit: { toString(): string } | null;
  instrument: { symbol: string };
  entryPrice: { toString(): string };
  units: { toString(): string };
}) {
  const mentor = await prisma.mentor.findUnique({ where: { userId: mentorUserId } });
  if (!mentor) return;
  const mentorPos = await prisma.ledgerEntry.findFirst({ where: { refType: 'Position', refId: pos.id, amount: { lt: 0n } } });
  if (!mentorPos) return;
  const mentorBal = (await balanceOf(mentorPos.accountId)) + -mentorPos.amount;
  const copies = await prisma.copyRelation.findMany({ where: { mentorId: mentor.id, status: 'ACTIVE' } });
  const name = mentor.displayName ?? mentor.handle;
  const sym = pos.instrument.symbol, { pip, unit } = pipInfo(sym), entry = Number(pos.entryPrice.toString());
  const dist = (x: { toString(): string } | null) => x ? `${(Math.abs(Number(x.toString()) - entry) / pip).toFixed(1)} ${unit}` : 'Not set';
  for (const copy of copies) {
    const fraction = Number(-mentorPos.amount) / Math.max(1, Number(mentorBal));
    const amount = BigInt(Math.floor(Number(copy.allocationMinor) * Math.min(fraction, 1)));
    if (amount < 1_000n) continue;
    if ((await balanceOf(copy.accountId)) < amount) continue;
    const opened = await openPosition({
      accountId: copy.accountId, sym, side: pos.side, amount,
      sl: pos.stopLoss?.toString(), tp: pos.takeProfit?.toString(),
      key: `copy:${copy.id}:${pos.id}`, sourceId: pos.id,
    }).catch(() => null);
    if (!opened) continue;
    const acc = await prisma.account.findUnique({ where: { id: copy.accountId }, select: { userId: true } });
    if (acc) void notify(acc.userId, `${name} opened a ${pos.side} on ${sym}`, `Your account mirrored ${name}'s new trade.`, true, [
      ['Time', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      ['Trade', `${pos.side} ${sym}`],
      ['Entry price', opened.entryPrice.toString()],
      ['Stop loss', dist(pos.stopLoss)],
      ['Take profit', dist(pos.takeProfit)],
      ['Your allocation', '$' + usd(BigInt(copy.allocationMinor))],
      ['Amount used in this trade', '$' + usd(amount)],
    ]).catch(() => {});
  }
}

// Called after a mentor closes a position.
export async function mirrorClose(sourceId: string) {
  const src = await prisma.position.findUnique({
    where: { id: sourceId }, include: { instrument: true, account: { include: { user: { include: { mentor: true } } } } },
  });
  const m = src?.account.user.mentor, name = m?.displayName ?? m?.handle ?? 'Your mentor';
  const positions = await prisma.position.findMany({ where: { sourceId, status: 'OPEN' }, include: { account: { select: { userId: true } } } });
  for (const p of positions) {
    const r = await closePosition(p.id).catch(() => null);
    if (!r) continue;
    const pnl = BigInt(r.pnl), inv = BigInt(r.invested);
    const signed = (pnl < 0n ? '-' : '+') + '$' + usd(pnl < 0n ? -pnl : pnl);
    const pct = inv > 0n ? ((Number(pnl) / Number(inv)) * 100).toFixed(2) : '0.00';
    void notify(p.account.userId, `${name} closed ${src?.instrument.symbol ?? 'a trade'}`,
      pnl >= 0n ? 'Your copied trade closed in profit.' : 'Your copied trade closed at a loss.', true, [
      ['Time', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      ['Trade', `${src?.side ?? ''} ${src?.instrument.symbol ?? ''}`.trim()],
      ['Entry / Exit', `${p.entryPrice.toString()} → ${r.exitPrice}`],
      ['Amount allocated to trade', '$' + usd(inv)],
      ['You earned', signed],
      ['Return', `${pnl >= 0n ? '+' : ''}${pct}%`],
      ['Returned to balance', '$' + usd(BigInt(r.payout))],
    ]).catch(() => {});
  }
}

export async function chargeFee(accountId: string, mentorId: string, feeMinor: bigint, period: string) {
  return prisma.$transaction((tx) =>
    postEntry(tx, {
      accountId,
      amount: -feeMinor,
      type: 'COPY_FEE',
      key: `copyfee:${accountId}:${mentorId}:${period}`,
      refType: 'Mentor',
      refId: mentorId,
    }));
}

export { audit };