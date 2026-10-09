import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notify.js';
import { balanceOf } from '../wallet/ledger.js';
import { chargeFee } from './copy.js';

export async function startRenewals() {
  const run = async () => {
    const now = new Date();
    if (now.getUTCDate() !== 1) return;
    const period = now.toISOString().slice(0, 7);
    const rels = await prisma.copyRelation.findMany({
      where: { status: 'ACTIVE' },
      include: { mentor: true, account: { select: { userId: true } } },
    });
    for (const c of rels) {
      const idempotencyKey = `copyfee:${c.accountId}:${c.mentorId}:${period}`;
      const done = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey } });
      if (done) continue;
      if ((await balanceOf(c.accountId)) < c.mentor.feeMinor) {
        await prisma.copyRelation.update({ where: { id: c.id }, data: { status: 'PAUSED' } });
        void notify(c.account.userId, 'Copying paused', 'Insufficient balance for the monthly subscription fee.', true)
          .catch((error) => console.error('copy renewal notification failed', error));
        continue;
      }
      await chargeFee(c.accountId, c.mentorId, c.mentor.feeMinor, period)
        .catch((error) => console.error(`copy renewal charge failed for ${c.id}`, error));
    }
  };
  const runWithLogging = () => {
    void run().catch((error) => console.error('copy renewals failed', error));
  };
  runWithLogging();
  const timer = setInterval(runWithLogging, 3 * 3600_000);
  return { close: async () => clearInterval(timer) };
}