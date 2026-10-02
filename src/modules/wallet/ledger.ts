import type { Prisma, LedgerType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

type Tx = Prisma.TransactionClient;

export async function balanceOf(accountId: string, tx: Tx | typeof prisma = prisma): Promise<bigint> {
  const r = await tx.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });
  return r._sum.amount ?? 0n;
}

// Call inside prisma.$transaction. Idempotent: same key returns the existing entry.
export async function postEntry(
  tx: Tx,
  e: { accountId: string; amount: bigint; type: LedgerType; key: string; refType?: string; refId?: string },
) {
  const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: e.key } });
  if (existing) return existing;
  if (e.amount < 0n) {
    // Serialize per account so concurrent debits can't overdraw.
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${e.accountId} FOR UPDATE`;
    if ((await balanceOf(e.accountId, tx)) + e.amount < 0n)
      throw Object.assign(new Error('INSUFFICIENT_FUNDS'), { statusCode: 400 });
  }
  return tx.ledgerEntry.create({
    data: {
      accountId: e.accountId,
      amount: e.amount,
      type: e.type,
      idempotencyKey: e.key,
      refType: e.refType,
      refId: e.refId,
    },
  });
}