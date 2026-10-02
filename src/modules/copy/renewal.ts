import { Queue, Worker } from 'bullmq';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { notify } from '../../lib/notify.js';
import { balanceOf } from '../wallet/ledger.js';
import { chargeFee } from './copy.js';

export async function startRenewals() {
  const q = new Queue('copy-renew', { connection: redis });
  await q.upsertJobScheduler('copy-renew-monthly', { pattern: '0 0 1 * *' }, { name: 'monthly', data: {} });
  await q.close();

  return new Worker('copy-renew', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const rels = await prisma.copyRelation.findMany({
      where: { status: 'ACTIVE' },
      include: { mentor: true, account: { select: { userId: true } } },
    });
    for (const c of rels) {
      if ((await balanceOf(c.accountId)) < c.mentor.feeMinor) {
        await prisma.copyRelation.update({ where: { id: c.id }, data: { status: 'PAUSED' } });
        void notify(c.account.userId, 'Copying paused', 'Insufficient balance for the monthly subscription fee.', true);
        continue;
      }
      await chargeFee(c.accountId, c.mentorId, c.mentor.feeMinor, period).catch(() => {});
    }
  }, { connection: redis });
}