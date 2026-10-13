import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { redis } from '../../lib/redis.js';
import { INSTRUMENTS } from '../market/instruments.js';
import { yahoo } from '../market/yahoo.js';

const q = z.object({
  sym: z.enum(INSTRUMENTS.map((instrument) => instrument.sym) as [string, ...string[]]),
  interval: z.enum(['1m', '5m', '15m', '1h', '1d']).default('5m'),
  range: z.enum(['1d', '5d', '1mo', '3mo', '1y']).default('5d'),
});

export const gymRoutes: FastifyPluginAsync = async (app) => {
  app.get('/candles', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { sym, interval, range } = q.parse(req.query);
    const cacheKey = `gym:${sym}:${interval}:${range}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const result = await yahoo(sym, interval, range);
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp || !quote?.open || !quote.high || !quote.low || !quote.close)
      return reply.code(503).send({ error: 'NO_DATA' });

    const items = result.timestamp
      .map((timestamp, index) => ({
        t: timestamp,
        o: quote.open?.[index],
        h: quote.high?.[index],
        l: quote.low?.[index],
        c: quote.close?.[index],
      }))
      .filter((candle) => [candle.o, candle.h, candle.l, candle.c].every((value) => typeof value === 'number' && Number.isFinite(value)));
    const data = { items };
    await redis.set(cacheKey, JSON.stringify(data), 'EX', 300);
    return data;
  });
};
