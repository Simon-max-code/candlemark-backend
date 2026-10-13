import { redis } from './redis.js';

function isRateMap(value: unknown): value is Record<string, number> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((rate) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0);
}

async function rates(): Promise<Record<string, number>> {
  const hit = await redis.get('fx:usd');
  if (hit) return JSON.parse(hit) as Record<string, number>;

  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`FX provider returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('rates' in payload) || !isRateMap(payload.rates) || payload.rates.USD !== 1)
      throw new Error('FX provider returned invalid rates');
    const serialized = JSON.stringify(payload.rates);
    await redis.set('fx:usd', serialized, 'EX', 3600);
    await redis.set('fx:stale', serialized, 'EX', 7 * 86400);
    return payload.rates;
  } catch (error) {
    console.warn('FX rate refresh failed; using stale rates when available', error);
  }

  const stale = await redis.get('fx:stale');
  return stale ? JSON.parse(stale) as Record<string, number> : { USD: 1 };
}

export async function fxFor(currency = 'USD') {
  const rate = (await rates())[currency];
  return rate ? { currency, rate } : { currency: 'USD', rate: 1 };
}
