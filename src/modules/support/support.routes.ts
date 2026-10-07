import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sendMail, tpl } from '../../lib/mail.js';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';

const body = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  subject: z.string().trim().min(3).max(120).regex(/^[^\r\n]+$/),
  message: z.string().trim().min(10).max(2000),
});

export const supportRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req) => {
    const b = body.parse(req.body);
    await sendMail({
      to: env.SUPPORT_EMAIL ?? env.MAIL_FROM_EMAIL,
      subject: `[Support] ${b.subject}`,
      html: tpl(`From ${b.name} <${b.email}>`, b.message),
    });
    await audit(null, 'support.message', req.ip);
    return { ok: true };
  });
};