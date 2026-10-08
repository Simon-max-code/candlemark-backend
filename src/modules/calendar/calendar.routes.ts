import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../../lib/redis.js';

const URL_ = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

async function load() {
  const hit = await redis.get('cal:data');
  if (hit) return JSON.parse(hit);
  try {
    const response = await fetch(URL_, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'mentorsedgepro/1.0' },
    });
    if (!response.ok) throw new Error(String(response.status));
    const raw: any[] = await response.json();
    const items = raw.map((event) => ({
      title: String(event.title ?? ''),
      ccy: String(event.country ?? ''),
      date: String(event.date ?? ''),
      impact: String(event.impact ?? 'Low'),
      forecast: String(event.forecast ?? ''),
      previous: String(event.previous ?? ''),
    }));
    const serialized = JSON.stringify(items);
    await redis.set('cal:data', serialized, 'EX', 1800);
    await redis.set('cal:stale', serialized, 'EX', 7 * 86400);
    return items;
  } catch {
    const stale = await redis.get('cal:stale');
    return stale ? JSON.parse(stale) : [];
  }
}

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => ({ items: await load() }));
};