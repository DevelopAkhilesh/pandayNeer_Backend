import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

export default defineConfig({
  test: {
    // The test database is a remote Neon branch: a single round trip costs
    // ~900ms, so one requestOtp is ~3-4s and the multi-request rate-limit
    // tests need well past the 30s these used to allow.
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
