import { z } from 'zod';

// "100.50" -> 10050n (cents)
export const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).transform((s) => {
  const [a, b = ''] = s.split('.');
  return BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
});

export const idemKey = z.string().min(8).max(100).regex(/^[\w-]+$/);