import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { uploadAvatar, isImage } from '../../lib/cloudinary.js';

export const profileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.post('/photo', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'NO_FILE' });
    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'FILE_TOO_LARGE' });
    if (!isImage(buffer)) return reply.code(400).send({ error: 'BAD_FILE_TYPE' });
    const avatarUrl = await uploadAvatar(buffer, req.user.sub);
    await prisma.user.update({ where: { id: req.user.sub }, data: { avatarUrl } });
    await audit(req.user.sub, 'profile.photo', req.ip);
    return { avatarUrl };
  });
};
