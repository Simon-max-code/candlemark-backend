import { buildApp } from './app.js';
import { env } from './config/env.js';
import { redis } from './lib/redis.js';
import { startMailWorker } from './lib/mail.js';
import { startRenewals } from './modules/copy/renewal.js';

(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const app = await buildApp();
const worker = startMailWorker();
const renewals = await startRenewals();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await worker.close(); await renewals.close(); await app.close(); redis.disconnect(); process.exit(0); });
}

await app.listen({ port: env.PORT, host: '0.0.0.0' });