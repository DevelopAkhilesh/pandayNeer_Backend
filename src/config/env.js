import 'dotenv/config';
import { z } from 'zod';
// env schema fro checking the env variables are correct or not
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(5050),

  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .startsWith(
      'postgresql://',
      'DATABASE_URL must be a valid PostgreSQL connection string'
    ),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  MSG91_AUTH_KEY: z.string().min(1).optional(),
  MSG91_SENDER_ID: z.string().length(6).optional(), // DLT header, e.g. PNDNER
  MSG91_TEMPLATE_ID: z.string().min(1).optional(), // DLT_TE_ID for the OTP template
  MSG91_ROUTE: z.string().default('4'),

  /**
   * Ceiling for the unauthenticated public endpoints — the catalogue and the
   * serviceability check — per IP per minute.
   *
   * Configurable rather than hardcoded so it can be tightened under abuse or
   * raised for a campaign without a deploy. It also lets the rate-limit tests
   * assert the behaviour with a handful of requests instead of 300: firing the
   * real ceiling took ~300ms alone and up to 10s under a loaded suite, which is
   * a timeout failure on correct code, not a bug worth chasing.
   */
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid or missing environment variables:\n${details}`);
}

export const env = parsed.data;

// Optional-in-dev, required-in-prod. Without this you deploy successfully and
// then discover at 2am that every OTP is going to stdout.
if (env.NODE_ENV === 'production') {
  const required = ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_TEMPLATE_ID'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing in production: ${missing.join(', ')}`);
  }
}
