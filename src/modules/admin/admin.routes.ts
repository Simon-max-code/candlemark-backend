import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticator } from 'otplib';
import { prisma } from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { signedUrl } from '../../lib/cloudinary.js';
import { postEntry, balanceOf } from '../wallet/ledger.js';
import { money, idemKey } from '../wallet/money.js';
import { notify, usd } from '../../lib/notify.js';

const s = (max = 200) => z.string().trim().min(1).max(max);
const idP = z.object({ id: s(40) });
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() });
const statusQ = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') });
const review = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(500).optional() });
const DENY = { error: 'STEP_UP_REQUIRED' };
const NF = { error: 'NOT_FOUND' };

const addr = {
  wire: z.object({ holder: s(), bank: s(), accountNumber: s(), routing: s(), address: s() }).strict(),
  sepa: z.object({ bank: s(), iban: s(), bic: s(), address: s() }).strict(),
  crypto: z.object({ btc: s(100), eth: s(100), usdtTrc20: s(100) }).strict(),
};

const handle = z.string().regex(/^[a-z0-9_]{3,30}$/);
const stats = z.object({
  gain: z.number().min(-100).max(100000), winRate: z.number().min(0).max(100),
  trades: z.number().int().min(0), capital: z.number().min(0),
  copiers: z.number().int().min(0), avgTime: s(30),
}).partial().strict();
const mentorFields = z.object({
  displayName: s(80), handle, tag: s(80), bio: s(500),
  riskScore: z.number().int().min(1).max(10), fee: money, verified: z.boolean(), stats,
}).partial();
const createMentor = mentorFields.extend({ email: z.string().trim().toLowerCase().email(), handle });
const toData = (b: z.infer<typeof mentorFields>) => ({
  displayName: b.displayName, handle: b.handle, tag: b.tag, bio: b.bio,
  riskScore: b.riskScore, feeMinor: b.fee, verified: b.verified,
});

async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
  const user = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { role: true, status: true, totpEnabled: true } });
  if (!user || user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
    reply.code(403).send({ error: 'FORBIDDEN' });
    return;
  }
  if (env.NODE_ENV === 'production' && !user.totpEnabled) reply.code(403).send({ error: 'ADMIN_2FA_REQUIRED' });
}

async function stepUp(req: FastifyRequest) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub }, select: { totpEnabled: true, totpSecret: true } });
  if (!user.totpEnabled) return env.NODE_ENV !== 'production';
  const code = String(req.headers['x-totp'] ?? '');
  return /^\d{6}$/.test(code) && authenticator.verify({ token: code, secret: decrypt(user.totpSecret!) });
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);
  app.addHook('preHandler', adminOnly);

  app.get('/stats', async () => {
    const [users, pendingKyc, pendingDeposits, pendingWithdrawals, total] = await Promise.all([
      prisma.user.count(),
      prisma.kycProfile.count({ where: { status: 'PENDING' } }),
      prisma.deposit.count({ where: { status: 'PENDING' } }),
      prisma.withdrawal.count({ where: { status: 'PENDING' } }),
      prisma.ledgerEntry.aggregate({ _sum: { amount: true } }),
    ]);
    return { users, pendingKyc, pendingDeposits, pendingWithdrawals, totalBalance: (total._sum.amount ?? 0n).toString() };
  });

  app.get('/users', async (req) => {
    const { q, status, limit, cursor } = page.extend({
      q: z.string().trim().max(100).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
    }).parse(req.query);
    const rows = await prisma.user.findMany({
      where: {
        ...(status && { status }),
        ...(q && { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }),
      },
      include: { kyc: { select: { status: true } }, accounts: { select: { id: true } } },
      orderBy: { createdAt: 'desc' }, take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const more = rows.length > limit;
    if (more) rows.pop();
    const sums = await prisma.ledgerEntry.groupBy({
      by: ['accountId'], where: { accountId: { in: rows.flatMap((user) => user.accounts.map((account) => account.id)) } }, _sum: { amount: true },
    });
    const balances = new Map(sums.map((sum) => [sum.accountId, sum._sum.amount ?? 0n]));
    return {
      items: rows.map((user) => ({
        id: user.id, email: user.email, name: user.name, country: user.country, role: user.role, status: user.status,
        kyc: user.kyc?.status ?? 'NOT_STARTED', createdAt: user.createdAt,
        balance: user.accounts.reduce((total, account) => total + (balances.get(account.id) ?? 0n), 0n).toString(),
      })),
      nextCursor: more ? rows[rows.length - 1].id : null,
    };
  });

  app.get('/users/:id', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id }, include: { kyc: true, accounts: true, mentor: { select: { id: true, handle: true } } },
    });
    if (!user) return reply.code(404).send(NF);
    const account = user.accounts[0];
    const [balance, open] = await Promise.all([
      account ? balanceOf(account.id) : Promise.resolve(0n),
      account ? prisma.position.count({ where: { accountId: account.id, status: 'OPEN' } }) : Promise.resolve(0),
    ]);
    return {
      id: user.id, email: user.email, name: user.name, country: user.country, role: user.role, status: user.status,
      totpEnabled: user.totpEnabled, createdAt: user.createdAt, mentor: user.mentor,
      kyc: { status: user.kyc?.status ?? 'NOT_STARTED', data: user.kyc?.data ?? null },
      balance: balance.toString(), openPositions: open,
    };
  });

  app.post('/users/:id/status', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const body = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']), reason: s(300) }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) return reply.code(404).send(NF);
    if (id === req.user.sub || target.role === 'ADMIN') return reply.code(400).send({ error: 'CANNOT_MODIFY_ADMIN' });
    await prisma.user.update({ where: { id }, data: { status: body.status } });
    if (body.status === 'ACTIVE') await redis.del(`blocked:${id}`);
    else {
      await redis.set(`blocked:${id}`, '1', 'EX', 1000);
      await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await prisma.copyRelation.updateMany({ where: { account: { userId: id }, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
    }
    await audit(req.user.sub, `admin.user_${body.status.toLowerCase()}`, req.ip, { userId: id, reason: body.reason });
    void notify(id, `Account ${body.status.toLowerCase()}`, body.status === 'ACTIVE' ? 'Your account is active again.' : 'Your account access has been restricted. Please contact support.', true).catch(() => {});
    return { status: body.status };
  });

  app.post('/users/:id/adjust', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const key = idemKey.parse(req.headers['idempotency-key']);
    const body = z.object({
      direction: z.enum(['CREDIT', 'DEBIT']), amount: money.refine((amount) => amount > 0n), reason: s(300),
    }).parse(req.body);
    if (!(await stepUp(req))) return reply.code(403).send(DENY);
    const account = await prisma.account.findFirst({ where: { userId: id, type: 'DEMO' } });
    if (!account) return reply.code(404).send(NF);
    await prisma.$transaction((tx) => postEntry(tx, {
      accountId: account.id, amount: body.direction === 'CREDIT' ? body.amount : -body.amount,
      type: 'ADJUSTMENT', key: `adj:${key}`, refType: 'Admin', refId: req.user.sub,
    }));
    await audit(req.user.sub, 'admin.adjust', req.ip, { userId: id, direction: body.direction, amount: body.amount.toString(), reason: body.reason });
    return { ok: true };
  });

  app.get('/kyc', async (req) => {
    const { status } = statusQ.parse(req.query);
    const rows = await prisma.kycProfile.findMany({
      where: { status }, include: { user: { select: { email: true, name: true } } }, orderBy: { updatedAt: 'asc' }, take: 100,
    });
    return { items: rows.map((kyc) => ({ userId: kyc.userId, email: kyc.user.email, name: kyc.user.name, status: kyc.status, data: kyc.data, submittedAt: kyc.updatedAt })) };
  });

  app.post('/kyc/:id/review', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const body = review.parse(req.body);
    const result = await prisma.kycProfile.updateMany({
      where: { userId: id, status: 'PENDING' }, data: { status: body.decision, reviewedBy: req.user.sub, reviewedAt: new Date() },
    });
    if (!result.count) return reply.code(409).send({ error: 'NOT_PENDING' });
    await audit(req.user.sub, `admin.kyc_${body.decision.toLowerCase()}`, req.ip, { userId: id, note: body.note });
    void notify(id, `Identity verification ${body.decision.toLowerCase()}`, body.decision === 'APPROVED' ? 'Your profile is verified. Withdrawals are now enabled.' : 'Your verification was not approved. Please contact support.', true).catch(() => {});
    return { status: body.decision };
  });

  app.get('/deposits', async (req) => {
    const { status } = statusQ.parse(req.query);
    const rows = await prisma.deposit.findMany({
      where: { status }, orderBy: { createdAt: 'asc' }, take: 100,
      include: { account: { include: { user: { select: { id: true, email: true, name: true } } } } },
    });
    return { items: rows.map((deposit) => ({
      id: deposit.id, user: deposit.account.user, method: deposit.method, amount: deposit.amountMinor.toString(), status: deposit.status,
      proofUrl: deposit.proofPublicId ? signedUrl(deposit.proofPublicId) : null, createdAt: deposit.createdAt,
    })) };
  });

  app.post('/deposits/:id/review', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const body = review.parse(req.body);
    if (!(await stepUp(req))) return reply.code(403).send(DENY);
    const ok = await prisma.$transaction(async (tx) => {
      const result = await tx.deposit.updateMany({ where: { id, status: 'PENDING' }, data: { status: body.decision, reviewedBy: req.user.sub } });
      if (!result.count) return false;
      if (body.decision === 'APPROVED') {
        const deposit = await tx.deposit.findUniqueOrThrow({ where: { id } });
        await postEntry(tx, { accountId: deposit.accountId, amount: deposit.amountMinor, type: 'DEPOSIT', key: `dep-credit:${id}`, refType: 'Deposit', refId: id });
      }
      return true;
    });
    if (!ok) return reply.code(409).send({ error: 'NOT_PENDING' });
    await audit(req.user.sub, `admin.deposit_${body.decision.toLowerCase()}`, req.ip, { id, note: body.note });
    const deposit = await prisma.deposit.findUnique({ where: { id }, include: { account: { select: { userId: true } } } });
    if (deposit) void notify(deposit.account.userId, `Deposit ${body.decision.toLowerCase()}`, `Your deposit of $${usd(deposit.amountMinor)} was ${body.decision.toLowerCase()}.${body.note ? ' Note: ' + body.note : ''}`, true).catch(() => {});
    return { status: body.decision };
  });

  app.get('/withdrawals', async (req) => {
    const { status } = statusQ.parse(req.query);
    const rows = await prisma.withdrawal.findMany({
      where: { status }, orderBy: { createdAt: 'asc' }, take: 100,
      include: { account: { include: { user: { select: { id: true, email: true, name: true } } } } },
    });
    return { items: rows.map((withdrawal) => ({
      id: withdrawal.id, user: withdrawal.account.user, network: withdrawal.network, destination: withdrawal.destination,
      amount: withdrawal.amountMinor.toString(), status: withdrawal.status, createdAt: withdrawal.createdAt,
    })) };
  });

  app.post('/withdrawals/:id/review', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const body = review.parse(req.body);
    if (!(await stepUp(req))) return reply.code(403).send(DENY);
    const ok = await prisma.$transaction(async (tx) => {
      const result = await tx.withdrawal.updateMany({ where: { id, status: 'PENDING' }, data: { status: body.decision, reviewedBy: req.user.sub } });
      if (!result.count) return false;
      if (body.decision === 'REJECTED') {
        const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
        await postEntry(tx, { accountId: withdrawal.accountId, amount: withdrawal.amountMinor, type: 'WITHDRAWAL', key: `wd-refund:${id}`, refType: 'Withdrawal', refId: id });
      }
      return true;
    });
    if (!ok) return reply.code(409).send({ error: 'NOT_PENDING' });
    await audit(req.user.sub, `admin.withdrawal_${body.decision.toLowerCase()}`, req.ip, { id, note: body.note });
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id }, include: { account: { select: { userId: true } } } });
    if (withdrawal) void notify(withdrawal.account.userId, `Withdrawal ${body.decision.toLowerCase()}`, `Your withdrawal of $${usd(withdrawal.amountMinor)} was ${body.decision.toLowerCase()}.${body.decision === 'REJECTED' ? ' The funds were returned to your balance.' : ''}`, true).catch(() => {});
    return { status: body.decision };
  });

  app.get('/deposit-addresses', async () => ({ items: await prisma.depositAddress.findMany() }));

  app.put('/deposit-addresses/:method', async (req, reply) => {
    const { method } = z.object({ method: z.enum(['wire', 'sepa', 'crypto']) }).parse(req.params);
    const details = addr[method].parse(req.body);
    if (!(await stepUp(req))) return reply.code(403).send(DENY);
    const old = await prisma.depositAddress.findUnique({ where: { method } });
    await prisma.depositAddress.upsert({
      where: { method }, update: { details, updatedBy: req.user.sub }, create: { method, details, updatedBy: req.user.sub },
    });
    await audit(req.user.sub, 'admin.deposit_address_update', req.ip, { method, from: old?.details ?? null, to: details });
    return { ok: true };
  });

  app.get('/mentors', async () => {
    const rows = await prisma.mentor.findMany({
      include: { user: { select: { email: true, name: true } }, _count: { select: { copiers: { where: { status: 'ACTIVE' } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((mentor) => ({
      id: mentor.id, userId: mentor.userId, email: mentor.user.email, displayName: mentor.displayName ?? mentor.user.name, handle: mentor.handle,
      tag: mentor.tag, bio: mentor.bio, risk: mentor.riskScore, fee: mentor.feeMinor.toString(), verified: mentor.verified,
      stats: mentor.stats ?? {}, activeCopiers: mentor._count.copiers,
    })) };
  });

  app.post('/mentors', async (req, reply) => {
    const body = createMentor.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    if (await prisma.mentor.findFirst({ where: { OR: [{ userId: user.id }, { handle: body.handle }] } }))
      return reply.code(409).send({ error: 'MENTOR_EXISTS' });
    const mentor = await prisma.$transaction(async (tx) => {
      const row = await tx.mentor.create({
        data: { ...toData(body), handle: body.handle, userId: user.id, verified: body.verified ?? true, stats: body.stats },
      });
      if (user.role === 'USER') await tx.user.update({ where: { id: user.id }, data: { role: 'MENTOR' } });
      return row;
    });
    await audit(req.user.sub, 'admin.mentor_create', req.ip, { id: mentor.id, userId: user.id });
    return reply.code(201).send({ id: mentor.id });
  });

  app.patch('/mentors/:id', async (req, reply) => {
    const { id } = idP.parse(req.params);
    const body = mentorFields.parse(req.body);
    const mentor = await prisma.mentor.findUnique({ where: { id } });
    if (!mentor) return reply.code(404).send(NF);
    try {
      await prisma.mentor.update({
        where: { id },
        data: { ...toData(body), ...(body.stats && { stats: { ...((mentor.stats as object) ?? {}), ...body.stats } }) },
      });
    } catch (error: any) {
      if (error.code === 'P2002') return reply.code(409).send({ error: 'HANDLE_TAKEN' });
      throw error;
    }
    await audit(req.user.sub, 'admin.mentor_update', req.ip, { id, fields: Object.keys(body) });
    return { ok: true };
  });

  app.get('/audit', async (req) => {
    const query = page.extend({ actorId: s(40).optional(), action: s(60).optional() }).parse(req.query);
    const rows = await prisma.auditLog.findMany({
      where: { ...(query.actorId && { actorId: query.actorId }), ...(query.action && { action: { startsWith: query.action } }) },
      orderBy: { createdAt: 'desc' }, take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    });
    const more = rows.length > query.limit;
    if (more) rows.pop();
    return { items: rows, nextCursor: more ? rows[rows.length - 1].id : null };
  });
};