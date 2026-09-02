import 'dotenv/config';
import { z } from 'zod';
// env schema fro checking the env variables are correct or not
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test']),
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

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid or missing environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// Optional-in-dev, required-in-prod. Without this you deploy successfully and
// then discover at 2am that every OTP is going to stdout.
if (env.NODE_ENV === 'production') {
  const required = ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_TEMPLATE_ID'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}
