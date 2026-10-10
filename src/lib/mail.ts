import { env } from '../config/env.js';

type Mail = { to: string; subject: string; html: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const APP = (env.APP_URL ?? env.CORS_ORIGIN.split(',')[0]).replace(/\/$/, '');

const shell = (pre: string, inner: string) => `<!doctype html><html><body style="margin:0;padding:0;background:#F4F6F8">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:Inter,'Segoe UI',Arial,sans-serif">
<tr><td style="background:#0A0D12;border-radius:16px 16px 0 0;padding:22px 32px;font-size:20px;font-weight:700;color:#FFFFFF">Mentorsedge<span style="color:#00E6A0">Pro</span></td></tr>
<tr><td style="background:#FFFFFF;padding:36px 32px;color:#1A2230;font-size:15px;line-height:1.6;border-left:1px solid #E3E8EE;border-right:1px solid #E3E8EE">${inner}</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid #E3E8EE;border-top:0;border-radius:0 0 16px 16px;padding:0 32px 28px;font-size:12px;line-height:1.6;color:#8A93A3">
<hr style="border:0;border-top:1px solid #E3E8EE;margin:0 0 16px">Need help? Contact <a href="${APP}/support.html" style="color:#00A878">Support</a>. We will never ask for your password or 2FA code.<br>Trading leveraged products carries a high risk of loss.</td></tr>
<tr><td style="padding:16px;text-align:center;font-size:11px;color:#8A93A3">&copy; ${new Date().getFullYear()} MentorsEdgePro</td></tr>
</table></td></tr></table></body></html>`;

export const tpl = (title: string, body: string, cta?: { label: string; url: string }, rows?: [string, string][]) => shell(title,
  `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0A0D12">${esc(title)}</h1><p style="margin:0 0 22px">${esc(body)}</p>` +
  (rows?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E3E8EE;border-radius:12px;margin:0 0 22px;border-collapse:separate;overflow:hidden">${rows.map(([k, v]) =>
    `<tr><td style="padding:11px 14px;color:#5C6577;font-size:13px;border-bottom:1px solid #EEF1F4">${esc(k)}</td><td style="padding:11px 14px;text-align:right;font-weight:600;border-bottom:1px solid #EEF1F4">${esc(v)}</td></tr>`).join('')}</table>` : '') +
  (cta ? `<a href="${esc(cta.url)}" style="display:inline-block;background:#00E6A0;color:#02110C;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:10px">${esc(cta.label)}</a>` : ''));

export const otpTpl = (code: string, purpose: 'verify' | 'reset') => shell(`Your code is ${code}`,
  `<h1 style="margin:0 0 12px;font-size:22px;color:#0A0D12">${purpose === 'verify' ? 'Verify your email' : 'Reset your password'}</h1>
<p style="margin:0 0 22px">${purpose === 'verify' ? 'Welcome to MentorsEdgePro. Enter this code to confirm your email address.' : 'Use this code to choose a new password.'}</p>
<div style="font:700 34px 'Courier New',monospace;letter-spacing:10px;text-align:center;background:#F0FBF7;border:1px dashed #00C98A;border-radius:12px;padding:18px 0 18px 10px;color:#0A0D12">${esc(code)}</div>
<p style="margin:22px 0 0;font-size:13px;color:#5C6577">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</p>`);

async function deliver(data: Mail) {
  if (!env.BREVO_API_KEY) {
    if (env.NODE_ENV === 'production') throw new Error('BREVO_API_KEY missing');
    console.log(`[mail:dev] to=${data.to} | ${data.subject}`);
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
}

export const sendMail = async (m: Mail) => {
  void (async () => {
    for (let i = 0; i < 4; i++) {
      try {
        await deliver(m);
        return;
      } catch (error) {
        if (i === 3) {
          console.error('mail failed', error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** i));
      }
    }
  })();
};