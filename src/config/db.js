import pkg from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env.js';

const { PrismaClient } = pkg;

// Opening a connection to Neon costs 3-5s from outside us-east-2 (TLS + auth
// + pooler handshake). Prisma's interactive transactions only allow `maxWait`
// ms to acquire one, so a pool that has drained to zero makes every
// transactional endpoint fail before it runs a single query. Keep connections
// alive rather than paying that handshake per request.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  min: 2,
  max: 10,
  // Must exceed the observed handshake, or acquisition fails on its own.
  connectionTimeoutMillis: 15_000,
  // pg-pool only reaps idle clients while the pool is above `min`, so this
  // trims bursts without letting the baseline collapse.
  idleTimeoutMillis: 60_000,
});

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Opens the pool before traffic arrives. `min` stops pg-pool from reaping
 * connections, but it never opens them eagerly — without this the first
 * request after boot still pays the full handshake and times out.
 */
export async function warmDbPool() {
  const started = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  console.log(`DB pool warm in ${Date.now() - started}ms`);
}
