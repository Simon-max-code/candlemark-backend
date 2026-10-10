export type Cls = 'forex' | 'stocks' | 'crypto' | 'indices' | 'commodities';
export type Inst = { sym: string; name: string; cls: Cls; base: number; dp: number };

export const INSTRUMENTS: Inst[] = [
  { sym: 'EUR/USD', name: 'Euro / US Dollar', cls: 'forex', base: 1.0842, dp: 4 },
  { sym: 'GBP/USD', name: 'Pound / US Dollar', cls: 'forex', base: 1.2716, dp: 4 },
  { sym: 'USD/JPY', name: 'Dollar / Yen', cls: 'forex', base: 151.62, dp: 2 },
  { sym: 'AUD/USD', name: 'Aussie / Dollar', cls: 'forex', base: 0.6512, dp: 4 },
  { sym: 'USD/CAD', name: 'Dollar / Loonie', cls: 'forex', base: 1.3688, dp: 4 },
  { sym: 'AAPL', name: 'Apple Inc.', cls: 'stocks', base: 169.44, dp: 2 },
  { sym: 'TSLA', name: 'Tesla Inc.', cls: 'stocks', base: 342.27, dp: 2 },
  { sym: 'NVDA', name: 'NVIDIA Corp.', cls: 'stocks', base: 1108.3, dp: 2 },
  { sym: 'MSFT', name: 'Microsoft Corp.', cls: 'stocks', base: 495.4, dp: 2 },
  { sym: 'AMZN', name: 'Amazon.com Inc.', cls: 'stocks', base: 262.65, dp: 2 },
  { sym: 'BTC/USD', name: 'Bitcoin', cls: 'crypto', base: 67214, dp: 2 },
  { sym: 'ETH/USD', name: 'Ethereum', cls: 'crypto', base: 3481, dp: 2 },
  { sym: 'SOL/USD', name: 'Solana', cls: 'crypto', base: 178.2, dp: 2 },
  { sym: 'XRP/USD', name: 'Ripple', cls: 'crypto', base: 0.612, dp: 4 },
  { sym: 'US500', name: 'S&P 500', cls: 'indices', base: 5614.2, dp: 1 },
  { sym: 'NAS100', name: 'Nasdaq 100', cls: 'indices', base: 19208, dp: 1 },
  { sym: 'US30', name: 'Dow Jones', cls: 'indices', base: 39872, dp: 1 },
  { sym: 'UK100', name: 'FTSE 100', cls: 'indices', base: 8194.5, dp: 1 },
  { sym: 'XAU/USD', name: 'Gold', cls: 'commodities', base: 2384.6, dp: 2 },
  { sym: 'XAG/USD', name: 'Silver', cls: 'commodities', base: 28.44, dp: 2 },
  { sym: 'WTI', name: 'Crude Oil WTI', cls: 'commodities', base: 78.44, dp: 2 },
  { sym: 'NATGAS', name: 'Natural Gas', cls: 'commodities', base: 2.31, dp: 3 },
];

export const pipInfo = (sym: string) => {
  const i = INSTRUMENTS.find((x) => x.sym === sym);
  if (!i) return { pip: 1, unit: 'points' };
  if (i.cls === 'forex') return { pip: 10 ** -i.dp, unit: 'pips' };
  return { pip: i.cls === 'crypto' || i.cls === 'indices' ? 1 : 0.01, unit: 'points' };
};