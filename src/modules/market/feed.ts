import { EventEmitter } from 'node:events';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { INSTRUMENTS } from './instruments.js';

const state = new Map<string, { price: number; open: number }>();
const liveSyms = new Set<string>();
const seen = new Map<string, number>();
export const feed = new EventEmitter();
export const isLive = (sym: string) => Date.now() - (seen.get(sym) ?? 0) < 20 * 60_000;

export function setLive(sym: string, price: number, open?: number) {
  const s = state.get(sym);
  if (!s || !(price > 0)) return;
  if (!liveSyms.has(sym)) { liveSyms.add(sym); s.open = open || price; }
  else if (open) s.open = open;
  s.price = price;
  seen.set(sym, Date.now());
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
  for (const i of INSTRUMENTS) if (isLive(i.sym)) out[i.sym] = state.get(i.sym)!.price.toFixed(i.dp);
  if (!Object.keys(out).length) return;
  redis.hset('prices', out).catch(() => {});
  feed.emit('tick', out);
}

export function quote(sym: string) {
  const s = state.get(sym);
  if (!s || !isLive(sym)) return null;
  return { price: s.price, chg: Number((((s.price - s.open) / s.open) * 100).toFixed(2)) };
}

export const snapshot = () =>
  Object.fromEntries(INSTRUMENTS.filter((i) => isLive(i.sym)).map((i) => [i.sym, state.get(i.sym)!.price.toFixed(i.dp)]));