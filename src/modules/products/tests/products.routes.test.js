import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// errorHandler reads env.NODE_ENV, and the real env module validates
// DATABASE_URL, JWT_SECRET and friends at import time. This test has no .env
// and does not need one — no request here gets far enough to verify a token.
vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

// Mocked so these tests are about routing, guards and the WHERE clause the
// controller builds — not about Postgres. The assertions below read the call
// arguments, which is the only way to prove the public catalogue filters on
// isDeposit without a database that contains one.
vi.mock('../../../config/db.js', () => ({
  prisma: {
    product: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const LIMIT = 300;
const WINDOW_MS = 60_000;

/**
 * A fresh app AND a fresh router module for every test.
 *
 * The limiter is constructed at module scope in products.routes.js, so its
 * MemoryStore lives as long as the module does. Mounting the same imported
 * router on a new express app does NOT give you a new store — the second test
 * would start with the first test's hits already spent. resetModules() before
 * the dynamic import is what actually clears it.
 *
 * The prisma mock is re-imported for the same reason: resetModules re-runs the
 * factory above, so the vi.fn() the router now holds is not the one this file
 * captured at the top.
 */
async function buildApp() {
  vi.resetModules();
  // resetModules clears the module registry, but NOT the vi.fn() instances the
  // factory above produced — vitest caches those per path, so the same spy is
  // handed to every test and its call history accumulates. The second test to
  // assert toHaveBeenCalledTimes(1) sees 2 and fails on a route that is
  // perfectly correct. mockClear, not mockReset: the resolved values set in the
  // factory must survive.
  vi.clearAllMocks();
  const { default: productRoutes } = await import('../products.routes.js');
  const { errorHandler } = await import('../../../middleware/errorHandler.js');
  const { prisma } = await import('../../../config/db.js');

  const app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  // validate() throws ZodError and lets it propagate — errorHandler is what
  // turns that into a 400. Without it mounted, a malformed request has nowhere
  // to go and the socket hangs until the test times out.
  app.use(errorHandler);
  return { app, prisma };
}

describe('GET /api/products (public catalogue)', () => {
  it('is reachable with no token', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
  });

  // The two filters that are the entire point of this endpoint. If either is
  // dropped, the failure is silent — the list just quietly contains something
  // it should not, and nothing 500s.
  it('asks for active, non-deposit rows only', async () => {
    const { app, prisma } = await buildApp();

    await request(app).get('/api/products');

    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.where).toEqual({ isActive: true, isDeposit: false });
  });

  it('sorts by price with a deterministic tiebreaker', async () => {
    const { app, prisma } = await buildApp();

    await request(app).get('/api/products');

    // Price alone is not a total order — two jars at 60.00 would come back in
    // whatever order Postgres felt like, and the catalogue would reshuffle
    // between refreshes.
    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.orderBy).toEqual([{ price: 'asc' }, { id: 'asc' }]);
  });

  it('never selects isDeposit or isActive', async () => {
    const { app, prisma } = await buildApp();

    await request(app).get('/api/products');

    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.select).not.toHaveProperty('isDeposit');
    expect(args.select).not.toHaveProperty('isActive');
  });

  it('wraps the list rather than returning a bare array', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: 'p1',
        name: '20L Water Jar',
        description: null,
        capacityMl: 20000,
        price: '60',
        imageUrl: null,
      },
    ]);

    const res = await request(app).get('/api/products');

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    // And the price arrives formatted, not as the "60" Prisma would hand over.
    expect(res.body.data[0].price).toBe('60.00');
  });

  it('ignores query filters instead of honouring them', async () => {
    const { app, prisma } = await buildApp();

    // No validate() on this route and no filters in the controller, so a
    // client cannot ask the public catalogue to include the hidden half.
    const res = await request(app).get(
      '/api/products?isActive=false&isDeposit=true'
    );

    expect(res.status).toBe(200);
    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.where).toEqual({ isActive: true, isDeposit: false });
  });
});

describe('deposit on the public catalogue', () => {
  it('reports a deposit when the product carries one, and null when it does not', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: 'p1',
        name: '20L Water Jar',
        description: null,
        capacityMl: 20000,
        price: '60',
        imageUrl: null,
        depositProduct: { name: '20L Jar Security Deposit', price: '300' },
      },
      {
        id: 'p2',
        name: '1L Bottle Pack (12)',
        description: null,
        capacityMl: 12000,
        price: '120',
        imageUrl: null,
        depositProduct: null,
      },
    ]);

    const res = await request(app).get('/api/products');

    expect(res.body.data[0].deposit).toEqual({
      name: '20L Jar Security Deposit',
      amount: '300.00',
    });
    // Explicitly null, not an absent key. Both products have the same shape,
    // so the client renders from the value rather than hardcoding which
    // products happen to need a deposit.
    expect(res.body.data[1]).toHaveProperty('deposit', null);
  });

  it('asks Prisma for the deposit name and price only', async () => {
    const { app, prisma } = await buildApp();

    await request(app).get('/api/products');

    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.select.depositProduct).toEqual({
      select: { name: true, price: true },
    });
  });
});

describe('admin routes', () => {
  // The guards themselves are shared middleware covered by the auth suite.
  // What is worth proving here is that they are actually mounted on these
  // routes — a missing requireAuth is invisible until someone finds it.
  it.each([
    ['get', '/api/products/admin'],
    ['get', '/api/products/11111111-0000-4000-8000-000000000001'],
    ['post', '/api/products'],
    ['patch', '/api/products/11111111-0000-4000-8000-000000000001'],
    ['delete', '/api/products/11111111-0000-4000-8000-000000000001'],
  ])('%s %s requires a token', async (method, path) => {
    const { app } = await buildApp();

    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });

  /**
   * The ordering hazard, same as '/check' in service-areas.
   *
   * If '/:id' were registered first, 'admin' would be matched as an id. It
   * would not even 404 cleanly — the uuid check would fail and an admin
   * opening the product list would be told "Invalid product id".
   */
  it('does not let /:id swallow /admin', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/api/products/admin');

    // 401 from requireAuth, not 400 from the uuid param check. Both are
    // rejections; only one means the router reached the right handler.
    expect(res.status).toBe(401);
    expect(res.body.message).not.toMatch(/product id/i);
  });

  it('rejects a malformed id before it reaches Prisma', async () => {
    const { app, prisma } = await buildApp();

    const res = await request(app).get('/api/products/not-a-uuid');

    // Still 401 — the guard runs before validate, so an unauthenticated
    // caller learns nothing about which ids exist.
    expect(res.status).toBe(401);
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /api/products rate limiting', () => {
  beforeEach(() => {
    // Fake timers so the window can be advanced instead of waited out. The
    // MemoryStore compares client.resetTime against Date.now(), which vitest
    // controls here.
    //
    // setImmediate is deliberately left real. Express 5 defers error
    // propagation through it, so faking it means any request that throws never
    // reaches errorHandler and the test hangs until it times out.
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

  it('allows requests up to the limit, then refuses with our message', async () => {
    const { app } = await buildApp();

    for (let i = 0; i < LIMIT; i++) {
      expect((await request(app).get('/api/products')).status).toBe(200);
    }

    const res = await request(app).get('/api/products');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      message: 'Too many requests. Please try again in a moment.',
    });
  });

  it('reports remaining quota in the standard headers only', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/api/products');
    expect(res.headers['ratelimit-limit']).toBe(String(LIMIT));
    expect(res.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));

    // legacyHeaders: false — the old X-RateLimit-* set must be gone.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('lets the caller through again once the window has elapsed', async () => {
    const { app } = await buildApp();

    for (let i = 0; i < LIMIT; i++) await request(app).get('/api/products');
    expect((await request(app).get('/api/products')).status).toBe(429);

    // One millisecond short of the window: still blocked. This is what proves
    // the window is real, rather than the counter being cleared eagerly.
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect((await request(app).get('/api/products')).status).toBe(429);

    vi.advanceTimersByTime(1);
    expect((await request(app).get('/api/products')).status).toBe(200);
  });

  // The limiter is mounted on '/' only. An admin whose session is being used
  // by the dashboard must not be locked out because the storefront on the same
  // office IP is busy.
  it('does not spend the public quota on admin routes', async () => {
    const { app } = await buildApp();

    for (let i = 0; i < 50; i++) await request(app).get('/api/products/admin');

    const res = await request(app).get('/api/products');
    expect(res.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));
  });
});
