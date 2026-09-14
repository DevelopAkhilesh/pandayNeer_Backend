import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Handler-level, not route-level. The guards are covered in
// products.routes.test.js; mounting them here would mean minting an admin JWT
// for every case, which tests the auth module a second time and says nothing
// about what create actually does.
vi.mock('../../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('../../../config/db.js', () => {
  const product = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
  };

  return {
    prisma: {
      product,
      // Runs the callback against the same mocked client, so both creates
      // inside the transaction land in the same call log.
      $transaction: vi.fn((fn) => fn({ product })),
    },
  };
});

const DEPOSIT_ID = '11111111-0000-4000-8000-000000000003';
const JAR_ID = '11111111-0000-4000-8000-000000000001';

async function buildApp() {
  vi.resetModules();

  const { validate } = await import('../../../middleware/validate.js');
  const { errorHandler } = await import('../../../middleware/errorHandler.js');
  const { createProductSchema } = await import('../products.schema.js');
  const { createProductHandler } = await import('../products.controller.js');
  const { prisma } = await import('../../../config/db.js');

  // mockReset, not clearAllMocks. clearAllMocks wipes call history but leaves
  // unconsumed mockResolvedValueOnce implementations QUEUED. A test that queues
  // two and consumes one — or that dies partway through because an unrelated
  // test timed out — hands its leftover value to whichever test runs next, and
  // a perfectly correct handler then returns the wrong thing. That is not
  // hypothetical: it turned the three duplicate-name tests red on unchanged
  // code, in runs where the rate-limit test in another file had timed out.
  //
  // The cost of mockReset is that the factory's resolved values go too, so the
  // baseline every test starts from is re-established here instead. Same shape
  // as the beforeEach in Otp.service.test.js, for the same reason.
  prisma.product.findFirst.mockReset().mockResolvedValue(null);
  prisma.product.findUnique.mockReset().mockResolvedValue(null);
  prisma.product.create.mockReset();
  prisma.$transaction
    .mockReset()
    .mockImplementation((fn) => fn({ product: prisma.product }));

  // Whatever create is given, echo back a plausible row. These tests are about
  // what the handler WRITES, not what Prisma returns.
  prisma.product.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 'generated-id', ...data })
  );

  const app = express();
  app.use(express.json());
  app.post('/', validate(createProductSchema), createProductHandler);
  app.use(errorHandler);
  return { app, prisma };
}

/** The rows passed to product.create, in call order. */
function created(prisma) {
  return prisma.product.create.mock.calls.map(([args]) => args.data);
}

describe('creating a product with no deposit', () => {
  // The 1L bottle pack. Disposable, nothing comes back, nothing held in trust.
  it('stores a null link and writes one row', async () => {
    const { app, prisma } = await buildApp();

    const res = await request(app).post('/').send({
      name: '1L Bottle Pack (12)',
      capacityMl: 12000,
      price: '120.00',
    });

    expect(res.status).toBe(201);
    expect(created(prisma)).toHaveLength(1);
    expect(created(prisma)[0].depositProductId).toBeNull();
  });

  it('does not open a transaction', async () => {
    const { app, prisma } = await buildApp();

    await request(app)
      .post('/')
      .send({ name: '1L Pack', capacityMl: 12000, price: '120.00' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('creating a product linked to an existing deposit', () => {
  it('checks the target is a real, active deposit before writing', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findUnique.mockResolvedValueOnce({
      id: DEPOSIT_ID,
      name: 'Jar Deposit',
      isDeposit: true,
      isActive: true,
    });

    const res = await request(app).post('/').send({
      name: '15L Water Jar',
      capacityMl: 15000,
      price: '50.00',
      depositProductId: DEPOSIT_ID,
    });

    expect(res.status).toBe(201);
    expect(created(prisma)[0].depositProductId).toBe(DEPOSIT_ID);
  });

  // The check that matters most: a jar pointed at another jar would charge
  // Rs 60 as a "deposit" and hand it back later as money held in trust, and
  // nothing downstream would catch it.
  it('refuses a link to something that is not a deposit', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findUnique.mockResolvedValueOnce({
      id: JAR_ID,
      name: '20L Water Jar',
      isDeposit: false,
      isActive: true,
    });

    const res = await request(app).post('/').send({
      name: '15L Water Jar',
      capacityMl: 15000,
      price: '50.00',
      depositProductId: JAR_ID,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/is not a deposit product/i);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('refuses a link to a retired deposit', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findUnique.mockResolvedValueOnce({
      id: DEPOSIT_ID,
      name: 'Old Jar Deposit',
      isDeposit: true,
      isActive: false,
    });

    const res = await request(app).post('/').send({
      name: '15L Water Jar',
      capacityMl: 15000,
      price: '50.00',
      depositProductId: DEPOSIT_ID,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/retired/i);
  });

  it('refuses a link to an id that does not exist', async () => {
    const { app } = await buildApp();
    // findUnique already resolves null by default.

    const res = await request(app).post('/').send({
      name: '15L Water Jar',
      capacityMl: 15000,
      price: '50.00',
      depositProductId: DEPOSIT_ID,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not exist/i);
  });
});

describe('creating a product and its deposit in one request', () => {
  const body = {
    name: '15L Water Jar',
    capacityMl: 15000,
    price: '50.00',
    deposit: { price: '250.00' },
  };

  it('writes the deposit first, then links the product to it', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.create
      .mockResolvedValueOnce({ id: 'new-deposit-id' })
      .mockResolvedValueOnce({ id: 'new-jar-id', name: '15L Water Jar' });

    const res = await request(app).post('/').send(body);

    expect(res.status).toBe(201);

    const [depositRow, jarRow] = created(prisma);
    expect(depositRow.isDeposit).toBe(true);
    expect(depositRow.price).toBe('250.00');
    // Order matters: the jar needs an id that does not exist until the deposit
    // row is written.
    expect(jarRow.depositProductId).toBe('new-deposit-id');
  });

  it('derives the deposit name from the product', async () => {
    const { app, prisma } = await buildApp();

    await request(app).post('/').send(body);

    // Retyping it is a chance to typo it, and the name is the only handle an
    // admin has on the row in the deposit dropdown later.
    expect(created(prisma)[0].name).toBe('15L Water Jar Deposit');
  });

  it('lets an explicit deposit name win', async () => {
    const { app, prisma } = await buildApp();

    await request(app)
      .post('/')
      .send({
        ...body,
        deposit: { name: 'Large Jar Deposit', price: '250.00' },
      });

    expect(created(prisma)[0].name).toBe('Large Jar Deposit');
  });

  it('inherits capacityMl so deposits stay distinguishable', async () => {
    const { app, prisma } = await buildApp();

    await request(app).post('/').send(body);

    // Meaningless as a volume on a deposit row, but it is what tells a 15L
    // deposit apart from a 20L one once there are several.
    expect(created(prisma)[0].capacityMl).toBe(15000);
  });

  it('stamps the deposit as published, since it is created live', async () => {
    const { app, prisma } = await buildApp();

    await request(app).post('/').send(body);

    // The jar itself is a draft — drafts are the default — but its deposit is
    // created live, and a live row is a published row. Without this the deposit
    // sits at isActive true with publishedAt null, a state nothing else in the
    // module can produce, and every publish-date view reads it as missing.
    const depositRow = created(prisma)[0];
    expect(depositRow.isActive).toBe(true);
    expect(depositRow.publishedAt).toBeInstanceOf(Date);
  });

  it('wraps both writes in one transaction', async () => {
    const { app, prisma } = await buildApp();

    await request(app).post('/').send(body);

    // Without it, a failed second insert leaves an orphan deposit attached to
    // nothing — and the admin's retry then collides with that orphan's name
    // and 409s for a product that does not exist yet.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('checks the derived deposit name for duplicates too', async () => {
    const { app, prisma } = await buildApp();
    // First call checks the product name, second checks the deposit's.
    prisma.product.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd-old', isActive: true });

    const res = await request(app).post('/').send(body);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/15L Water Jar Deposit/);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });
});

describe('duplicate product names', () => {
  it('409s on a live duplicate', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p1',
      isActive: true,
    });

    const res = await request(app)
      .post('/')
      .send({ name: '20L Water Jar', capacityMl: 20000, price: '60.00' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it('points at the retired row rather than just refusing', async () => {
    const { app, prisma } = await buildApp();
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p9',
      isActive: false,
    });

    const res = await request(app)
      .post('/')
      .send({ name: '5L Bottle', capacityMl: 5000, price: '25.00' });

    expect(res.status).toBe(409);
    // Without this, the admin hunts for a row that is not in their default
    // view, gives up, and creates the duplicate under a slightly different
    // name.
    expect(res.body.message).toMatch(/isActive=false/);
  });
});
