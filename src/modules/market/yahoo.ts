export const YF: Record<string, string> = {
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'JPY=X',
  'AUD/USD': 'AUDUSD=X',
  'USD/CAD': 'CAD=X',
  AAPL: 'AAPL',
  TSLA: 'TSLA',
  NVDA: 'NVDA',
  MSFT: 'MSFT',
  AMZN: 'AMZN',
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
  'SOL/USD': 'SOL-USD',
  'XRP/USD': 'XRP-USD',
  US500: '^GSPC',
  NAS100: '^NDX',
  US30: '^DJI',
  UK100: '^FTSE',
  'XAU/USD': 'GC=F',
  'XAG/USD': 'SI=F',
  WTI: 'CL=F',
  NATGAS: 'NG=F',
};

export type YahooChart = {
  meta?: {
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
  };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
    }>;
  };
};

export async function yahoo(sym: string, interval = '1m', range = '1d'): Promise<YahooChart | null> {
  const symbol = YF[sym];
  if (!symbol) return null;
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`,
      { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return null;
    const payload = await response.json() as { chart?: { result?: YahooChart[] | null } };
    return payload.chart?.result?.[0] ?? null;
  } catch {
    return null;
  }
}
