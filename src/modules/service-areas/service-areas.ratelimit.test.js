import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// errorHandler reads env.NODE_ENV, and the real env module validates
// DATABASE_URL, JWT_SECRET and friends at import time. This test has no .env
// and does not need one.
vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

// The route reads through service-areas.cache.js, which loads the active set
// with findMany. Mocking the db module keeps this test about the limiter — and
// note the cache means 121 requests produce ONE query, not 121.
vi.mock('../../config/db.js', () => ({
  prisma: {
    serviceArea: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ pincode: '400053', areaName: 'Andheri West' }]),
    },
  },
}));

const LIMIT = 300;
const WINDOW_MS = 60_000;

/**
 * A fresh app AND a fresh router module for every test.
 *
 * The limiter is constructed at module scope in service-areas.routes.js, so
 * its MemoryStore lives as long as the module does. Mounting the same imported
 * router on a new express app does NOT give you a new store — the second test
 * would start at 120 hits already spent. resetModules() before the dynamic
 * import is what actually clears it.
 */
async function buildApp() {
  vi.resetModules();
  const { default: serviceAreaRoutes } =
    await import('./service-areas.routes.js');
  const { errorHandler } = await import('../../middleware/errorHandler.js');

  const app = express();
  app.use('/api/service-areas', serviceAreaRoutes);
  // validate() throws ZodError and lets it propagate — errorHandler is what
  // turns that into a 400. Without it mounted, a malformed request has nowhere
  // to go and the socket just hangs until the test times out.
  app.use(errorHandler);
  return app;
}

function check(app, pincode = '400053') {
  return request(app).get(`/api/service-areas/check?pincode=${pincode}`);
}

describe('GET /api/service-areas/check rate limiting', () => {
  beforeEach(() => {
    // Fake timers so the window can be advanced instead of waited out. The
    // MemoryStore compares client.resetTime against Date.now(), which vitest
    // controls here.
    //
    // setImmediate is deliberately left real. Express 5 defers error
    // propagation through it, so faking it means any request that throws —
    // a failed zod parse, for one — never reaches errorHandler and the test
    // hangs until it times out. The happy path doesn't defer, which is why
    // only the validation test would break.
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit', async () => {
    const app = await buildApp();

    for (let i = 0; i < LIMIT; i++) {
      expect((await check(app)).status).toBe(200);
    }
  });

  it('rejects the next request with 429 and our message', async () => {
    const app = await buildApp();

    for (let i = 0; i < LIMIT; i++) await check(app);

    const res = await check(app);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      message: 'Too many requests. Please try again in a moment.',
    });
  });

  it('reports remaining quota in the standard headers only', async () => {
    const app = await buildApp();

    const res = await check(app);
    expect(res.headers['ratelimit-limit']).toBe(String(LIMIT));
    expect(res.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));

    // legacyHeaders: false — the old X-RateLimit-* set must be gone.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('lets the caller through again once the window has elapsed', async () => {
    const app = await buildApp();

    for (let i = 0; i < LIMIT; i++) await check(app);
    expect((await check(app)).status).toBe(429);

    // One millisecond short of the window: still blocked. This is what proves
    // the window is real, rather than the counter being cleared eagerly.
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect((await check(app)).status).toBe(429);

    vi.advanceTimersByTime(1);
    const res = await check(app);
    expect(res.status).toBe(200);
    // Fresh window, and this request is the first hit in it.
    expect(res.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));
  });

  it('anchors the window to the first request, not the last', async () => {
    const app = await buildApp();

    for (let i = 0; i < LIMIT; i++) await check(app);

    // Hammering inside the window does not extend it. Every one of these is
    // refused, and the caller is still free at the 60s mark measured from the
    // very first request.
    vi.advanceTimersByTime(WINDOW_MS - 5_000);
    for (let i = 0; i < 30; i++) {
      expect((await check(app)).status).toBe(429);
    }

    vi.advanceTimersByTime(5_000);
    expect((await check(app)).status).toBe(200);
  });

  it('counts a validation failure as a hit', async () => {
    const app = await buildApp();

    // The limiter is mounted before validate(), so a malformed pincode still
    // spends quota. Deliberate — otherwise sending garbage is a free way to
    // probe the endpoint forever.
    const bad = await check(app, 'abc');
    expect(bad.status).toBe(400);
    expect(bad.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));
  });
});
