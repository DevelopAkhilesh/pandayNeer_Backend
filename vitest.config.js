import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

export default defineConfig({
  test: {
    // The test database is local Postgres in Docker (see .env.test), so a round
    // trip is sub-millisecond and every test is bounded by bcrypt at 10 rounds
    // (~100ms per hash), not by the network. The slowest tests are the ones
    // that loop over the hourly cap — a handful of hashes, well under a second.
    // 10s is headroom for a cold container, not a latency allowance: if a test
    // approaches it, something is wrong rather than slow.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    fileParallelism: false,
  },
});
