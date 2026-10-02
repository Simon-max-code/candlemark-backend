import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: string };
    user: { sub: string; role: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(jwt, { secret: env.JWT_ACCESS_SECRET, sign: { expiresIn: '15m' } });
  app.decorate('auth', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'UNAUTHORIZED' }); return; }
    if (await redis.exists(`blocked:${req.user.sub}`)) reply.code(403).send({ error: 'ACCOUNT_SUSPENDED' });
  });
});