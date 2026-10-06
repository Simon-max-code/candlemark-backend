import type { FastifyPluginAsync, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { prisma } from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { sendOtp, checkOtp } from './otp.js';

const RT_DAYS = 30;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const prod = env.NODE_ENV === 'production';
const cookieOpts = {
  path: '/auth', httpOnly: true, sameSite: (prod ? 'none' : 'lax') as 'none' | 'lax',
  secure: prod, maxAge: RT_DAYS * 86400,
};

async function issue(app: FastifyInstance, reply: FastifyReply, u: { id: string; role: string }, ua?: string) {
  const raw = randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: { userId: u.id, tokenHash: sha(raw), userAgent: ua, expiresAt: new Date(Date.now() + RT_DAYS * 864e5) },
  });
  reply.setCookie('rt', raw, cookieOpts);
  return app.jwt.sign({ sub: u.id, role: u.role });
}

const registerBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  country: z.string().trim().max(60).optional(),
});
const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) });

const publicUser = (u: { id: string; email: string; name: string; country: string | null; role: string; totpEnabled: boolean }) =>
  ({ id: u.id, email: u.email, name: u.name, country: u.country, role: u.role, totpEnabled: u.totpEnabled });

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = registerBody.parse(req.body);
    if (await prisma.user.findUnique({ where: { email: b.email } }))
      return reply.code(409).send({ error: 'EMAIL_TAKEN' });

    const passwordHash = await argon2.hash(b.password);
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { email: b.email, name: b.name, country: b.country, passwordHash, accounts: { create: { type: 'DEMO' } } },
        include: { accounts: true },
      });
      await tx.ledgerEntry.create({
        data: { accountId: u.accounts[0].id, amount: 1_000_000n, type: 'DEMO_FUNDING', idempotencyKey: `demo-fund:${u.accounts[0].id}` },
      });
      await tx.kycProfile.create({ data: { userId: u.id } });
      return u;
    });

    await audit(user.id, 'auth.register', req.ip);
    await sendOtp(user.id, user.email, 'verify');
    return reply.code(201).send({ needsVerification: true, email: user.email });
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = loginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: b.email } });
    if (!user || !(await argon2.verify(user.passwordHash, b.password))) {
      await audit(user?.id ?? null, 'auth.login_failed', req.ip);
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    if (user.status !== 'ACTIVE') return reply.code(403).send({ error: 'ACCOUNT_SUSPENDED' });
    if (!user.emailVerified) {
      await sendOtp(user.id, user.email, 'verify');
      return reply.code(403).send({ error: 'EMAIL_NOT_VERIFIED', email: user.email });
    }
    if (user.totpEnabled) {
      if (!b.totp) return reply.code(401).send({ error: 'TOTP_REQUIRED' });
      if (!authenticator.verify({ token: b.totp, secret: decrypt(user.totpSecret!) })) {
        await audit(user.id, 'auth.totp_failed', req.ip);
        return reply.code(401).send({ error: 'INVALID_TOTP' });
      }
    }
    await audit(user.id, 'auth.login', req.ip);
    const accessToken = await issue(app, reply, user, req.headers['user-agent']);
    return { accessToken, user: publicUser(user) };
  });

  const emailBody = z.object({ email: z.string().trim().toLowerCase().email() });
  const otpBody = emailBody.extend({ code: z.string().regex(/^\d{6}$/) });

  app.post('/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = otpBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || user.status !== 'ACTIVE' || !(await checkOtp(user.id, 'verify', body.code)))
      return reply.code(400).send({ error: 'INVALID_CODE' });
    const verifiedUser = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    await audit(user.id, 'auth.email_verified', req.ip);
    const accessToken = await issue(app, reply, verifiedUser, req.headers['user-agent']);
    return { accessToken, user: publicUser(verifiedUser) };
  });

  app.post('/resend-otp', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = emailBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE' && !user.emailVerified) await sendOtp(user.id, user.email, 'verify');
    return { ok: true };
  });

  app.post('/forgot-password', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = emailBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE') await sendOtp(user.id, user.email, 'reset');
    return { ok: true };
  });

  app.post('/reset-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = otpBody.extend({ password: z.string().min(8).max(128) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || user.status !== 'ACTIVE' || !(await checkOtp(user.id, 'reset', body.code)))
      return reply.code(400).send({ error: 'INVALID_CODE' });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(body.password), emailVerified: true } });
    await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(user.id, 'auth.password_reset', req.ip);
    return { ok: true };
  });

  app.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = req.cookies.rt;
    if (!raw) return reply.code(401).send({ error: 'NO_REFRESH' });
    const t = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) }, include: { user: true } });
    if (!t || t.expiresAt < new Date()) return reply.code(401).send({ error: 'INVALID_REFRESH' });
    if (t.user.status !== 'ACTIVE') return reply.code(403).send({ error: 'ACCOUNT_SUSPENDED' });
    if (t.revokedAt) {
      await prisma.refreshToken.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(t.userId, 'auth.refresh_reuse', req.ip);
      return reply.code(401).send({ error: 'INVALID_REFRESH' });
    }
    await prisma.refreshToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } });
    const accessToken = await issue(app, reply, t.user, req.headers['user-agent']);
    return { accessToken, user: publicUser(t.user) };
  });

  app.post('/logout', async (req, reply) => {
    const raw = req.cookies.rt;
    if (raw) await prisma.refreshToken.updateMany({ where: { tokenHash: sha(raw), revokedAt: null }, data: { revokedAt: new Date() } });
    reply.clearCookie('rt', { path: '/auth', sameSite: cookieOpts.sameSite, secure: prod });
    return { ok: true };
  });

  app.get('/me', { preHandler: app.auth }, async (req, reply) => {
    const u = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { kyc: { select: { status: true } }, accounts: { select: { id: true, type: true, currency: true } } },
    });
    if (!u) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    return { ...publicUser(u), kycStatus: u.kyc?.status ?? 'NOT_STARTED', accounts: u.accounts };
  });

  app.patch('/me', { preHandler: app.auth }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(100), country: z.string().trim().max(60).optional() }).parse(req.body);
    const u = await prisma.user.update({ where: { id: req.user.sub }, data: { name: b.name, country: b.country || null } });
    await audit(u.id, 'auth.profile_update', req.ip);
    return publicUser(u);
  });

  app.post('/change-password', { preHandler: app.auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ current: z.string().min(1).max(128), password: z.string().min(8).max(128) }).parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!(await argon2.verify(u.passwordHash, b.current))) return reply.code(400).send({ error: 'INVALID_CREDENTIALS' });
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await argon2.hash(b.password) } });
    await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(u.id, 'auth.password_change', req.ip);
    return { ok: true };
  });

  app.post('/2fa/setup', { preHandler: app.auth }, async (req) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: u.id }, data: { totpSecret: encrypt(secret), totpEnabled: false } });
    return { secret, otpauth: authenticator.keyuri(u.email, 'MentorsEdgePro', secret) };
  });

  app.post('/2fa/enable', { preHandler: app.auth }, async (req, reply) => {
    const { code } = codeBody.parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!u.totpSecret || !authenticator.verify({ token: code, secret: decrypt(u.totpSecret) }))
      return reply.code(400).send({ error: 'INVALID_TOTP' });
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
    await audit(u.id, 'auth.2fa_enabled', req.ip);
    return { ok: true };
  });

  app.post('/2fa/disable', { preHandler: app.auth }, async (req, reply) => {
    const { code } = codeBody.parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!u.totpSecret || !authenticator.verify({ token: code, secret: decrypt(u.totpSecret) }))
      return reply.code(400).send({ error: 'INVALID_TOTP' });
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecret: null } });
    await audit(u.id, 'auth.2fa_disabled', req.ip);
    return { ok: true };
  });
};