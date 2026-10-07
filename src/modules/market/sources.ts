import WebSocket from 'ws';
import { env } from '../../config/env.js';
import { setLive } from './feed.js';

const BIN: Record<string, string> = { BTCUSDT: 'BTC/USD', ETHUSDT: 'ETH/USD', SOLUSDT: 'SOL/USD', XRPUSDT: 'XRP/USD' };
const FH: Record<string, string> = {
  AAPL: 'AAPL', TSLA: 'TSLA', NVDA: 'NVDA', MSFT: 'MSFT', AMZN: 'AMZN',
  'OANDA:EUR_USD': 'EUR/USD', 'OANDA:GBP_USD': 'GBP/USD', 'OANDA:USD_JPY': 'USD/JPY',
  'OANDA:AUD_USD': 'AUD/USD', 'OANDA:USD_CAD': 'USD/CAD',
};

function binance() {
  const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr'); // US region: stream.binance.us
  ws.on('message', (d) => {
    try { for (const t of JSON.parse(d.toString())) { const s = BIN[t.s]; if (s) setLive(s, +t.c, +t.o); } } catch {}
  });
  ws.on('error', () => {});
  ws.on('close', () => setTimeout(binance, 5000));
}

async function finnhub() {
  const key = env.FINNHUB_KEY;
  if (!key) return;
  for (const k of Object.keys(FH).filter((x) => !x.includes(':'))) {
    const r: any = await fetch(`https://finnhub.io/api/v1/quote?symbol=${k}&token=${key}`).then((x) => x.json()).catch(() => null);
    if (r?.c) setLive(FH[k], r.c, r.pc || undefined);
  }
  const connect = () => {
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${key}`);
    ws.on('open', () => { for (const k of Object.keys(FH)) ws.send(JSON.stringify({ type: 'subscribe', symbol: k })); });
    ws.on('message', (d) => {
      try { const m = JSON.parse(d.toString()); if (m.type === 'trade') for (const t of m.data) { const s = FH[t.s]; if (s) setLive(s, t.p); } } catch {}
    });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(connect, 5000));
  };
  connect();
}

const TD: Record<string, string> = {
  'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD', 'WTI': 'WTI/USD', 'NATGAS': 'NG/USD',
  'US500': 'SPX', 'NAS100': 'IXIC', 'US30': 'DJI', 'UK100': 'FTSE',
};

async function twelve() {
  const key = env.TWELVE_KEY;
  if (!key) return;
  const run = async () => {
    const r: any = await fetch(`https://api.twelvedata.com/quote?symbol=${Object.values(TD).join(',')}&apikey=${key}`)
      .then((x) => x.json()).catch(() => null);
    if (!r) return;
    for (const [mine, theirs] of Object.entries(TD)) {
      const q = r[theirs] ?? r[theirs.replace('/', '')];
      if (q?.close) setLive(mine, +q.close, +q.previous_close || undefined);
    }
  };
  await run();
  setInterval(run, 15 * 60_000);
}

export function startSources() { binance(); void finnhub(); void twelve(); }