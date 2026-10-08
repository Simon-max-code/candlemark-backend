import { prisma } from './prisma.js';
import { sendMail, tpl, APP } from './mail.js';

export const usd = (cents: bigint) => {
  const absolute = cents < 0n ? -cents : cents;
  const whole = (absolute / 100n).toLocaleString('en-US');
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${cents < 0n ? '-' : ''}${whole}.${fraction}`;
};

export async function notify(userId: string, title: string, body: string, email = false) {
  await prisma.notification.create({ data: { userId, title, body } }).catch(() => {});
  if (!email) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (user) await sendMail({ to: user.email, subject: title, html: tpl(title, body, { label: 'Open dashboard', url: `${APP}/dashboard.html` }) }).catch(() => {});
}