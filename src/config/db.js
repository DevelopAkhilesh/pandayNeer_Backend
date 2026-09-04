import pkg from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env.js';

const { PrismaClient } = pkg;

// Opening a connection costs ~490ms (TCP, TLS, SCRAM auth, and Supavisor
// opening its own upstream connection to Postgres — about 8 round trips).
// Prisma's interactive transactions allow `maxWait` ms to acquire one, so a
// pool that has drained to zero puts that whole handshake inside a request
// that has 2s to find a connection. Keep connections alive instead of paying
// it per request: with the pool warm the median query is 66ms, not 500ms.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  min: 2,
  max: 10,
  // Must exceed the ~490ms handshake with room to spare.
  connectionTimeoutMillis: 5_000,
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
