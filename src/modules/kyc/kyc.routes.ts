import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { uploadPrivate, isImage } from '../../lib/cloudinary.js';

const s = (max: number, min = 1) => z.string().trim().min(min).max(max);
const CCY = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'ZAR', 'AED', 'NGN'];
const kycBody = z.object({
  title: z.enum(['Mr', 'Mrs', 'Ms', 'Dr']),
  firstName: s(60), lastName: s(60),
  dob: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
  houseNo: s(20), street: s(120), city: s(80), province: s(80), zip: s(20),
  phone: z.string().regex(/^[\d+\s()-]{7,20}$/),
  employment: s(40), incomeSource: s(60), industry: s(120), education: s(40),
  annual: s(30), netWorth: s(30), volume: s(30), frequency: s(40),
  purpose: s(300, 3), experience: s(60),
  currency: s(60).refine((value) => CCY.includes(value.slice(0, 3)), 'Unsupported currency'),
}).refine((b) => {
  const [d, m, y] = b.dob.split('/').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return false;
  const age = (Date.now() - dt.getTime()) / 31557600000;
  return age >= 18 && age <= 100;
}, { message: 'Invalid date of birth', path: ['dob'] });

export const kycRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const k = await prisma.kycProfile.upsert({
      where: { userId: req.user.sub }, update: {}, create: { userId: req.user.sub },
    });
    return { status: k.status, data: k.data };
  });

  app.post('/id', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const k = await prisma.kycProfile.upsert({
      where: { userId: req.user.sub }, update: {}, create: { userId: req.user.sub },
    });
    if (k.status === 'PENDING' || k.status === 'APPROVED')
      return reply.code(409).send({ error: 'KYC_LOCKED', status: k.status });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'NO_FILE' });
    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'FILE_TOO_LARGE' });
    if (!isImage(buffer)) return reply.code(400).send({ error: 'BAD_FILE_TYPE' });

    const uploaded = await uploadPrivate(buffer, `kyc/${req.user.sub}`);
    await prisma.kycDocument.deleteMany({ where: { kycId: k.id, kind: 'ID_FRONT' } });
    await prisma.kycDocument.create({
      data: { kycId: k.id, kind: 'ID_FRONT', publicId: uploaded.public_id, url: uploaded.secure_url },
    });
    await audit(req.user.sub, 'kyc.id_upload', req.ip);
    return { ok: true };
  });

  app.put('/', async (req, reply) => {
    const data = kycBody.parse(req.body);
    const k = await prisma.kycProfile.upsert({
      where: { userId: req.user.sub }, update: {}, create: { userId: req.user.sub },
    });
    if (k.status === 'PENDING' || k.status === 'APPROVED')
      return reply.code(409).send({ error: 'KYC_LOCKED', status: k.status });
    if (!(await prisma.kycDocument.count({ where: { kycId: k.id, kind: 'ID_FRONT' } })))
      return reply.code(400).send({ error: 'ID_REQUIRED' });
    await prisma.kycProfile.update({ where: { id: k.id }, data: { data, status: 'PENDING' } });
    await prisma.account.updateMany({
      where: { userId: req.user.sub, type: 'LIVE' },
      data: { currency: data.currency.slice(0, 3) },
    });
    await audit(req.user.sub, 'kyc.submit', req.ip);
    return { status: 'PENDING' };
  });

};