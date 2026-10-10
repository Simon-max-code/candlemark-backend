import { EventEmitter } from 'node:events';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { INSTRUMENTS } from './instruments.js';

const state = new Map<string, { price: number; open: number }>();
const liveSyms = new Set<string>();
const seen = new Map<string, number>();
const known = new Set<string>(); // symbols that have had a real price at least once (live or restored)
const LAST_KEY = 'px:last';
export const feed = new EventEmitter();
export const isLive = (sym: string) => Date.now() - (seen.get(sym) ?? 0) < 20 * 60_000;

export function setLive(sym: string, price: number, open?: number) {
  const s = state.get(sym);
  if (!s || !(price > 0)) return;
  if (!liveSyms.has(sym)) { liveSyms.add(sym); s.open = open || price; }
  else if (open) s.open = open;
  s.price = price;
  seen.set(sym, Date.now());
  known.add(sym);
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
  // restore last known prices so closed markets (weekends, overnight) still show a price after a restart
  try {
    const saved = await redis.hgetall(LAST_KEY);
    for (const [sym, raw] of Object.entries(saved)) {
      const s = state.get(sym);
      if (!s) continue;
      const v = JSON.parse(raw) as { p: number; o: number };
      if (v.p > 0 && v.o > 0) { s.price = v.p; s.open = v.o; known.add(sym); }
    }
  } catch { /* redis unavailable: fall back to live-only */ }
  const timer = setInterval(tick, 1000);
  const saver = setInterval(persist, 30_000);
  return () => { clearInterval(timer); clearInterval(saver); };
}

function persist() {
  const out: Record<string, string> = {};
  for (const sym of known) {
    const s = state.get(sym);
    if (s) out[sym] = JSON.stringify({ p: s.price, o: s.open });
  }
  if (Object.keys(out).length) redis.hset(LAST_KEY, out).catch(() => {});
}

function tick() {
  const out: Record<string, string> = {};
  for (const i of INSTRUMENTS) if (isLive(i.sym)) out[i.sym] = state.get(i.sym)!.price.toFixed(i.dp);
  if (!Object.keys(out).length) return;
  feed.emit('tick', out);
}

export function quote(sym: string) {
  const s = state.get(sym);
  if (!s || !known.has(sym)) return null;
  return { price: s.price, chg: Number((((s.price - s.open) / s.open) * 100).toFixed(2)), closed: !isLive(sym) };
}

export const snapshot = () =>
  Object.fromEntries(INSTRUMENTS.filter((i) => isLive(i.sym)).map((i) => [i.sym, state.get(i.sym)!.price.toFixed(i.dp)]));