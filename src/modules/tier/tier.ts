import { prisma } from '../../lib/prisma.js';

export const TIERS = [
  { tier: 1, min: 0n, wdPct: 10, maxOpen: 1 },
  { tier: 2, min: 1_000_000n, wdPct: 20, maxOpen: 1 },
  { tier: 3, min: 2_500_000n, wdPct: 30, maxOpen: 50 },
  { tier: 4, min: 3_500_000n, wdPct: 50, maxOpen: 50 },
];

export async function tierOf(userId: string) {
  const [kyc, dep] = await Promise.all([
    prisma.kycProfile.findUnique({ where: { userId }, select: { status: true } }),
    prisma.deposit.aggregate({ where: { status: 'APPROVED', account: { userId } }, _sum: { amountMinor: true } }),
  ]);
  const total = dep._sum.amountMinor ?? 0n;
  if (kyc?.status !== 'APPROVED')
    return { tier: 0, wdPct: 0, maxOpen: 1, deposited: total.toString(), progress: 0, next: { tier: 1, min: '0' } };
  const cur = [...TIERS].reverse().find((t) => total >= t.min)!;
  const next = TIERS[cur.tier] ?? null;
  const progress = next ? Math.min(100, Math.floor((Number(total - cur.min) * 100) / Number(next.min - cur.min))) : 100;
  return { tier: cur.tier, wdPct: cur.wdPct, maxOpen: cur.maxOpen, deposited: total.toString(), progress, next: next && { tier: next.tier, min: next.min.toString() } };
}
