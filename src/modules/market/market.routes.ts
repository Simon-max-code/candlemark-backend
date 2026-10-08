import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { INSTRUMENTS } from './instruments.js';
import { quote } from './feed.js';

const q = z.object({ asset: z.enum(['forex', 'stocks', 'crypto', 'indices', 'commodities']).optional() });

export const marketRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { asset } = q.parse(req.query);
    return {
      items: INSTRUMENTS.filter((i) => !asset || i.cls === asset).flatMap((i) => {
        const q = quote(i.sym);
        return q ? [{ sym: i.sym, name: i.name, asset: i.cls, ...q }] : [];
      }),
    };
  });
};