import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { postEntry, balanceOf } from '../wallet/ledger.js';
import { openPosition, closePosition } from '../trading/engine.js';

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
  for (const copy of copies) {
    const fraction = Number(-mentorPos.amount) / Math.max(1, Number(mentorBal));
    const amount = BigInt(Math.floor(Number(copy.allocationMinor) * Math.min(fraction, 1)));
    if (amount < 1_000n) continue;
    const balance = await balanceOf(copy.accountId);
    if (balance < amount) continue;
    await openPosition({
      accountId: copy.accountId,
      sym: pos.instrument.symbol,
      side: pos.side,
      amount,
      sl: pos.stopLoss?.toString(),
      tp: pos.takeProfit?.toString(),
      key: `copy:${copy.id}:${pos.id}`,
      sourceId: pos.id,
    }).catch(() => {});
  }
}

// Called after a mentor closes a position.
export async function mirrorClose(sourceId: string) {
  const positions = await prisma.position.findMany({ where: { sourceId, status: 'OPEN' } });
  for (const position of positions) await closePosition(position.id).catch(() => {});
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