import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1),
  DATA_ENC_KEY: z.string().min(32),
  JWT_ACCESS_SECRET: z.string().min(32).refine((v) => process.env.NODE_ENV !== 'production' || !v.startsWith('change-me'), 'set a real secret'),
  JWT_REFRESH_SECRET: z.string().min(32).refine((v) => process.env.NODE_ENV !== 'production' || !v.startsWith('change-me'), 'set a real secret'),
  CLOUDINARY_URL: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  FINNHUB_KEY: z.string().optional(),
  TWELVE_KEY: z.string().optional(),
  MAIL_FROM_EMAIL: z.string().email().default('no-reply@example.com'),
  MAIL_FROM_NAME: z.string().default('MentorsEdgePro'),
});

export const env = schema.parse(process.env);