import { EventEmitter } from 'node:events';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { INSTRUMENTS, type Cls } from './instruments.js';

const VOL: Record<Cls, number> = { forex: 0.0004, stocks: 0.002, crypto: 0.004, indices: 0.001, commodities: 0.0016 };
const state = new Map<string, { price: number; open: number }>();
const liveSyms = new Set<string>();
export const feed = new EventEmitter();

export function setLive(sym: string, price: number, open?: number) {
  const s = state.get(sym);
  if (!s || !(price > 0)) return;
  if (!liveSyms.has(sym)) { liveSyms.add(sym); s.open = open || price; }
  else if (open) s.open = open;
  s.price = price;
}

export async function startFeed() {
  for (const i of INSTRUMENTS) {
    await prisma.instrument.upsert({
      where: { symbol: i.sym },
      update: { name: i.name, assetClass: i.cls },
      create: { symbol: i.sym, name: i.name, assetClass: i.cls },
    });
    state.set(i.sym, { price: i.base, open: i.base });
  }
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

function tick() {
  const out: Record<string, string> = {};
  for (const i of INSTRUMENTS) {
    const s = state.get(i.sym)!;
    if (!liveSyms.has(i.sym)) {
      const next = s.price * (1 + (Math.random() - 0.5) * VOL[i.cls]);
      s.price = Math.min(i.base * 1.2, Math.max(i.base * 0.8, next));
    }
    out[i.sym] = s.price.toFixed(i.dp);
  }
  redis.hset('prices', out).catch(() => {});
  feed.emit('tick', out);
}

export function quote(sym: string) {
  const s = state.get(sym);
  if (!s) return null;
  return { price: s.price, chg: Number((((s.price - s.open) / s.open) * 100).toFixed(2)) };
}

export const snapshot = () =>
  Object.fromEntries(INSTRUMENTS.map((i) => [i.sym, state.get(i.sym)!.price.toFixed(i.dp)]));