import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { redis } from '../../lib/redis.js';
import { env } from '../../config/env.js';
import { sendMail, otpTpl } from '../../lib/mail.js';

export type Purpose = 'verify' | 'reset' | 'reset2fa';
const TTL = 600, MAX_TRIES = 5;
const hash = (code: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(code).digest('hex');
const subj: Record<Purpose, string> = { verify: 'Verify your email', reset: 'Reset your password', reset2fa: 'Reset your two-factor authentication' };

export async function sendOtp(userId: string, email: string, purpose: Purpose) {
  if (!(await redis.set(`otp:cool:${purpose}:${userId}`, '1', 'EX', 60, 'NX'))) return false;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await redis.multi().set(`otp:${purpose}:${userId}`, hash(code), 'EX', TTL).del(`otp:tries:${purpose}:${userId}`).exec();
  await sendMail({
    to: email, subject: subj[purpose],
    html: otpTpl(code, purpose),
  });
  return true;
}

export async function checkOtp(userId: string, purpose: Purpose, code: string) {
  const triesKey = `otp:tries:${purpose}:${userId}`;
  const tries = await redis.incr(triesKey);
  if (tries === 1) await redis.expire(triesKey, TTL);
  if (tries > MAX_TRIES) return false;
  const key = `otp:${purpose}:${userId}`;
  const stored = await redis.get(key);
  if (!stored) return false;
  const a = Buffer.from(stored), b = Buffer.from(hash(code));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return (await redis.del(key)) === 1;
}