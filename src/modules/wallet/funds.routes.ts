import type { Deposit, Withdrawal } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { uploadPrivate } from '../../lib/cloudinary.js';
import { postEntry } from './ledger.js';
import { money, idemKey } from './money.js';
import { notify, usd } from '../../lib/notify.js';

const MIN_DEPOSIT = 10_000n; // $100
const MIN_WITHDRAW = 1_000n; // $10

const MAGIC = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], [0x25, 0x50, 0x44, 0x46]];
const validType = (buffer: Buffer) => MAGIC.some((magic) => magic.every((byte, index) => buffer[index] === byte));

const depositBody = z.object({ amount: money, method: z.enum(['wire', 'sepa', 'crypto']) });
const withdrawBody = z.object({
  amount: money,
  network: z.enum(['BTC', 'USDT_TRC20', 'ETH_ERC20']),
  destination: z.string().trim().regex(/^[A-Za-z0-9]{20,100}$/),
});

const dep = (d: Deposit) => ({ id: d.id, method: d.method, amount: d.amountMinor.toString(), status: d.status, createdAt: d.createdAt });
const wd = (w: Withdrawal) => ({ id: w.id, network: w.network, destination: w.destination, amount: w.amountMinor.toString(), status: w.status, createdAt: w.createdAt });

export const fundsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);
  const myAccount = (userId: string) => prisma.account.findFirstOrThrow({ where: { userId, type: 'DEMO' } });
  const key = (header: unknown) => idemKey.parse(header);

  app.get('/deposit-methods', async () => {
    const rows = await prisma.depositAddress.findMany();
    return Object.fromEntries(rows.map((row) => [row.method, row.details]));
  });

  // Multipart text fields (amount, method) must precede the file.
  app.post('/deposits', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const idempotencyKey = `dep:${req.user.sub}:${key(req.headers['idempotency-key'])}`;
    const existing = await prisma.deposit.findUnique({ where: { idempotencyKey } });
    if (existing) return dep(existing);

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'NO_PROOF' });
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const body = depositBody.parse({ amount: fields.amount?.value, method: fields.method?.value });
    if (body.amount < MIN_DEPOSIT)
      return reply.code(400).send({ error: 'BELOW_MIN', min: MIN_DEPOSIT.toString() });

    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'FILE_TOO_LARGE' });
    if (!validType(buffer)) return reply.code(400).send({ error: 'BAD_FILE_TYPE' });

    const account = await myAccount(req.user.sub);
    const uploaded = await uploadPrivate(buffer, `deposits/${req.user.sub}`);
    const deposit = await prisma.deposit.create({
      data: {
        accountId: account.id,
        method: body.method,
        amountMinor: body.amount,
        proofUrl: uploaded.secure_url,
        proofPublicId: uploaded.public_id,
        idempotencyKey,
      },
    });
    await audit(req.user.sub, 'deposit.create', req.ip, { id: deposit.id });
    return reply.code(201).send(dep(deposit));
  });

  app.get('/deposits', async (req) => {
    const account = await myAccount(req.user.sub);
    const rows = await prisma.deposit.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: rows.map(dep) };
  });

  // Funds are debited at request time (held); admin rejection refunds them.
  app.post('/withdrawals', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const idempotencyKey = `wd:${req.user.sub}:${key(req.headers['idempotency-key'])}`;
    const existing = await prisma.withdrawal.findUnique({ where: { idempotencyKey } });
    if (existing) return wd(existing);

    const body = withdrawBody.parse(req.body);
    if (body.amount < MIN_WITHDRAW)
      return reply.code(400).send({ error: 'BELOW_MIN', min: MIN_WITHDRAW.toString() });
    const kyc = await prisma.kycProfile.findUnique({ where: { userId: req.user.sub } });
    if (kyc?.status !== 'APPROVED') return reply.code(403).send({ error: 'KYC_REQUIRED' });

    const account = await myAccount(req.user.sub);
    const withdrawal = await prisma.$transaction(async (tx) => {
      const row = await tx.withdrawal.create({
        data: {
          accountId: account.id,
          network: body.network,
          destination: body.destination,
          amountMinor: body.amount,
          idempotencyKey,
        },
      });
      await postEntry(tx, {
        accountId: account.id,
        amount: -body.amount,
        type: 'WITHDRAWAL',
        key: `wd-hold:${row.id}`,
        refType: 'Withdrawal',
        refId: row.id,
      });
      return row;
    });
    await audit(req.user.sub, 'withdrawal.create', req.ip, { id: withdrawal.id });
    void notify(req.user.sub, 'Withdrawal requested', `Your withdrawal of $${usd(body.amount)} is pending review.`, true).catch(() => {});
    return reply.code(201).send(wd(withdrawal));
  });

  app.get('/withdrawals', async (req) => {
    const account = await myAccount(req.user.sub);
    const rows = await prisma.withdrawal.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: rows.map(wd) };
  });
};