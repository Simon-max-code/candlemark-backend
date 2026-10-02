import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { redis } from './lib/redis.js';
import authPlugin from './plugins/auth.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { kycRoutes } from './modules/kyc/kyc.routes.js';
import { walletRoutes } from './modules/wallet/wallet.routes.js';
import { fundsRoutes } from './modules/wallet/funds.routes.js';
import { marketRoutes } from './modules/market/market.routes.js';
import { startFeed } from './modules/market/feed.js';
import { attachWs } from './modules/market/ws.js';
import { tradeRoutes } from './modules/trading/trading.routes.js';
import { startTriggers } from './modules/trading/engine.js';
import { copyRoutes } from './modules/copy/copy.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';

export async function buildApp() {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    logger: env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty' } }
      : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: env.CORS_ORIGIN.split(','), credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', redis, nameSpace: 'rl:' });
  await app.register(underPressure, { maxEventLoopDelay: 2000, retryAfter: 10 });

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const o = req.headers.origin;
    if (o && !env.CORS_ORIGIN.split(',').includes(o)) return reply.code(403).send({ error: 'BAD_ORIGIN' });
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
  });

  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(kycRoutes, { prefix: '/kyc' });
  await app.register(walletRoutes, { prefix: '/wallet' });
  await app.register(fundsRoutes, { prefix: '/wallet' });
  await app.register(marketRoutes, { prefix: '/markets' });
  const stopFeed = await startFeed();
  app.addHook('onClose', async () => stopFeed());
  attachWs(app.server);
  startTriggers();
  await app.register(tradeRoutes, { prefix: '/trades' });
  await app.register(copyRoutes, { prefix: '/copy' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(notificationRoutes, { prefix: '/notifications' });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: 'VALIDATION', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err
      ? err.statusCode
      : undefined;
    if (typeof statusCode === 'number' && statusCode < 500) return reply.send(err);
    app.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL' });
  });

  app.get('/health', async () => ({ ok: true, redis: (await redis.ping()) === 'PONG' }));

  return app;
}