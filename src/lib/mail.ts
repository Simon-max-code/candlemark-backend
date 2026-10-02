import { Queue, Worker } from 'bullmq';
import { redis } from './redis.js';
import { env } from '../config/env.js';

type Mail = { to: string; subject: string; html: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const tpl = (title: string, body: string) =>
  `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">${esc(title)}</h2><p style="font-size:15px;line-height:1.5">${esc(body)}</p><p style="color:#888;font-size:12px;margin-top:24px">MentorsEdgePro</p></div>`;

const queue = new Queue<Mail>('mail', {
  connection: redis,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 },
});

export const sendMail = (m: Mail) => queue.add('send', m);

export function startMailWorker() {
  return new Worker<Mail>('mail', async ({ data }) => {
    if (!env.BREVO_API_KEY) {
      if (env.NODE_ENV === 'production') throw new Error('BREVO_API_KEY missing');
      console.log(`[mail:dev] to=${data.to} | ${data.subject} | ${data.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
      return;
    }
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
        to: [{ email: data.to }], subject: data.subject, htmlContent: data.html,
      }),
    });
    if (!response.ok) throw new Error(`brevo ${response.status}`);
  }, { connection: redis, concurrency: 5 });
}