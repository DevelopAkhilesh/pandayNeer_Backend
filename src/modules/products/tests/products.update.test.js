import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The update path, and the rules it has to enforce that create already does.
 *
 * Every case here is the same shape of bug: a rule written where the risk was
 * obvious, and never walked back through asking "can PATCH reach this state
 * another way?". A product born correct stayed correct; a product edited into
 * the bad state slipped through.
 *
 * This matters more now that products are created as drafts. Publishing is
 * PATCH { isActive: true }, so the update path is how every product reaches
 * customers — it is not an edge case any more.
 */
vi.mock('../../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

vi.mock('../../../config/db.js', () => {
  const product = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  };
  return { prisma: { product, $transaction: vi.fn((fn) => fn({ product })) } };
});

const JAR_ID = '11111111-0000-4000-8000-000000000001';
const DEPOSIT_ID = '11111111-0000-4000-8000-000000000003';
const OTHER_DEPOSIT_ID = '11111111-0000-4000-8000-000000000006';

async function buildApp() {
  vi.resetModules();

  const { validate } = await import('../../../middleware/validate.js');
  const { errorHandler } = await import('../../../middleware/errorHandler.js');
  const { updateProductSchema } = await import('../products.schema.js');
  const { updateProductHandler } = await import('../products.controller.js');
  const { prisma } = await import('../../../config/db.js');

  // mockReset, not clearAllMocks — the latter leaves unconsumed
  // mockResolvedValueOnce implementations queued for the next test. See the
  // note in products.create.test.js, where that leak turned correct code red.
  prisma.product.findFirst.mockReset().mockResolvedValue(null);
  prisma.product.findUnique.mockReset().mockResolvedValue(null);
  prisma.product.count.mockReset().mockResolvedValue(0);
  prisma.product.update
    .mockReset()
    .mockImplementation(({ data }) =>
      Promise.resolve({ id: JAR_ID, name: 'Row', price: '60', ...data })
    );

  const app = express();
  app.use(express.json());
  app.patch('/:id', validate(updateProductSchema), updateProductHandler);
  app.use(errorHandler);
  return { app, prisma };
}

/**
 * findUnique is called for two different purposes in this handler: loading the
 * row being edited, and loading a deposit being linked. Routing by id keeps the
 * tests readable and order-independent.
 */
function seedRows(prisma, rows) {
  prisma.product.findUnique.mockImplementation(({ where }) =>
    Promise.resolve(rows[where.id] ?? null)
  );
}

const activeJar = {
  id: JAR_ID,
  name: '20L Water Jar',
  isDeposit: false,
  isActive: true,
  depositProductId: DEPOSIT_ID,
};

const activeDeposit = {
  id: DEPOSIT_ID,
  name: '20L Jar Security Deposit',
  isDeposit: true,
  isActive: true,
  depositProductId: null,
};

describe('publishing a draft re-checks its deposit', () => {
  // The hole: deactivateProductHandler counts only ACTIVE products pointing at
  // a deposit, which is right for that handler — a staged product is not
  // selling, so it does not block a retirement. But nothing re-validated when
  // the staged product was later switched on, so it went live advertising a
  // deposit whose row had been retired in the meantime.
  it('refuses to publish a product whose deposit was retired', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: { ...activeJar, isActive: false },
      [DEPOSIT_ID]: { ...activeDeposit, isActive: false },
    });

    const res = await request(app).patch(`/${JAR_ID}`).send({ isActive: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/retired/i);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('publishes when the deposit is still usable', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: { ...activeJar, isActive: false },
      [DEPOSIT_ID]: activeDeposit,
    });

    const res = await request(app).patch(`/${JAR_ID}`).send({ isActive: true });

    expect(res.status).toBe(200);
  });

  it('publishes a product that carries no deposit', async () => {
    // The bottle pack. Nothing to validate.
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: { ...activeJar, isActive: false, depositProductId: null },
    });

    const res = await request(app).patch(`/${JAR_ID}`).send({ isActive: true });

    expect(res.status).toBe(200);
  });

  it('publishes while clearing a deposit that has been retired', async () => {
    // Clearing the link and publishing in one request. The deposit on its way
    // OUT must not be validated — and a retired deposit is the usual reason
    // someone is clearing it, so this is the common case, not an edge one.
    //
    // The bug this pins was one operator: `data.depositProductId ??
    // current.depositProductId` falls through on null as well as undefined, so
    // it could not tell "the admin did not mention this field" from "the admin
    // sent null to clear it". Presence is the question, not value.
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: { ...activeJar, isActive: false },
      [DEPOSIT_ID]: { ...activeDeposit, name: 'Old Deposit', isActive: false },
    });

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ isActive: true, depositProductId: null });

    expect(res.status).toBe(200);
    const [args] = prisma.product.update.mock.calls[0];
    expect(args.data.depositProductId).toBeNull();
  });

  it('still validates a deposit being swapped in while publishing', async () => {
    // The mirror case. Clearing skips the check; replacing must not.
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: { ...activeJar, isActive: false },
      [OTHER_DEPOSIT_ID]: {
        ...activeDeposit,
        id: OTHER_DEPOSIT_ID,
        name: 'Replacement Deposit',
        isActive: false,
      },
    });

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ isActive: true, depositProductId: OTHER_DEPOSIT_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/retired/i);
  });

  it('does not re-check when retiring', async () => {
    // Switching a product OFF closes the catalogue entry. Whatever state its
    // deposit is in stops mattering the moment it does.
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: activeJar,
      [DEPOSIT_ID]: { ...activeDeposit, isActive: false },
    });

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
  });
});

describe('publishedAt stamps the first publish only', () => {
  it('stamps a draft going live', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: {
        ...activeJar,
        isActive: false,
        publishedAt: null,
        depositProductId: null,
      },
    });

    await request(app).patch(`/${JAR_ID}`).send({ isActive: true });

    const [args] = prisma.product.update.mock.calls[0];
    expect(args.data.publishedAt).toBeInstanceOf(Date);
  });

  it('leaves the original date alone when a retired product returns', async () => {
    // It did go live back then. Rewriting the stamp would turn a retired
    // product's history into a fresh publish, and DRAFT vs RETIRED is exactly
    // what this column exists to tell apart.
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: {
        ...activeJar,
        isActive: false,
        publishedAt: new Date('2026-01-01'),
        depositProductId: null,
      },
    });

    await request(app).patch(`/${JAR_ID}`).send({ isActive: true });

    const [args] = prisma.product.update.mock.calls[0];
    expect(args.data.publishedAt).toBeUndefined();
  });

  it('does not stamp when retiring', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, { [JAR_ID]: activeJar });

    await request(app).patch(`/${JAR_ID}`).send({ isActive: false });

    const [args] = prisma.product.update.mock.calls[0];
    expect(args.data.publishedAt).toBeUndefined();
  });
});

describe('deposits cannot be chained on update', () => {
  // Create refuses this through a schema refine. Update reached the same state
  // because assertUsableDeposit validates the TARGET of the link and never
  // asked whether the row being edited is itself a deposit.
  it('refuses to give a deposit row a deposit', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [DEPOSIT_ID]: activeDeposit,
      [OTHER_DEPOSIT_ID]: { ...activeDeposit, id: OTHER_DEPOSIT_ID },
    });

    const res = await request(app)
      .patch(`/${DEPOSIT_ID}`)
      .send({ depositProductId: OTHER_DEPOSIT_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot itself carry a deposit/i);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  // Blocking the rule above also closes the loop case: a row that can never
  // hold a link cannot be part of a cycle. Self-reference was the only loop
  // guard before, which caught D3 -> D3 and nothing longer.
  it('makes a two-row cycle unreachable', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [DEPOSIT_ID]: { ...activeDeposit, depositProductId: OTHER_DEPOSIT_ID },
      [OTHER_DEPOSIT_ID]: { ...activeDeposit, id: OTHER_DEPOSIT_ID },
    });

    const res = await request(app)
      .patch(`/${OTHER_DEPOSIT_ID}`)
      .send({ depositProductId: DEPOSIT_ID });

    expect(res.status).toBe(400);
  });

  it('still lets an ordinary product take a deposit', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, {
      [JAR_ID]: { ...activeJar, depositProductId: null },
      [DEPOSIT_ID]: activeDeposit,
    });

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ depositProductId: DEPOSIT_ID });

    expect(res.status).toBe(200);
  });
});

describe('renaming checks for duplicates', () => {
  // assertNameIsFree ran on create only, so two products could end up sharing a
  // name through a rename — the exact state its own docblock argues against.
  it('refuses a name another product already uses', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, { [JAR_ID]: activeJar });
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'some-other-row',
      isActive: true,
    });

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ name: '10L Water Jar' });

    expect(res.status).toBe(409);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  // Without excludeId, saving a form that did not change the name would 409
  // the row against itself.
  it('allows a product to keep its own name', async () => {
    const { app, prisma } = await buildApp();
    seedRows(prisma, { [JAR_ID]: activeJar });

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ name: '20L Water Jar', price: '65.00' });

    expect(res.status).toBe(200);

    const [args] = prisma.product.findFirst.mock.calls[0];
    expect(args.where.id).toEqual({ not: JAR_ID });
  });
});

describe('the extra read is only taken when needed', () => {
  it('skips it for a plain price change', async () => {
    // A price edit touches none of the three rules, and paying for a findUnique
    // on every PATCH to serve cases that did not arrive is a real cost on the
    // handler an admin uses most.
    const { app, prisma } = await buildApp();

    const res = await request(app).patch(`/${JAR_ID}`).send({ price: '65.00' });

    expect(res.status).toBe(200);
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the row being edited does not exist', async () => {
    // findUnique returns null rather than throwing, so without this the handler
    // would fall through to update() and surface P2025 — right status, but only
    // by accident, and after the checks had already read undefined fields.
    const { app, prisma } = await buildApp();
    seedRows(prisma, {});

    const res = await request(app)
      .patch(`/${JAR_ID}`)
      .send({ name: 'Anything' });

    expect(res.status).toBe(404);
  });
});
