import { describe, it, expect } from 'vitest';
import {
  createProductSchema,
  updateProductSchema,
  listProductsSchema,
} from '../products.schema.js';

// Pure zod, no app and no database. These are the rules that are cheapest to
// break and most expensive to break — a price that gets through as a float is
// not a 500, it is a slightly wrong number in a column nobody re-reads.

const create = createProductSchema.body;
const update = updateProductSchema.body;
const query = listProductsSchema.query;

/** The first issue message for a given field, or undefined. */
function issueFor(schema, input, field) {
  const result = schema.safeParse(input);
  if (result.success) return undefined;
  return result.error.issues.find((i) => i.path.join('.') === field)?.message;
}

const water = { name: '20L Water Jar', capacityMl: 20000, price: '60' };

describe('price', () => {
  it('accepts zero, one or two decimal places', () => {
    for (const value of ['60', '60.5', '60.50', '0.05', '99999999.99']) {
      const result = create.safeParse({ ...water, price: value });
      expect(result.success, value).toBe(true);
      // Passed through untouched — no rounding, no reformatting, no parseFloat.
      expect(result.data.price).toBe(value);
    }
  });

  // The whole reason price is a string. A client that sends the number it has
  // must be told what is wrong, not "Price is required" for a field it sent.
  it('rejects a JSON number and says why', () => {
    expect(issueFor(create, { ...water, price: 60 }, 'price')).toMatch(
      /must be sent as a string/i
    );
  });

  it('still says "required" when it is actually missing', () => {
    // delete rather than a rest-destructure: argsIgnorePattern only exempts
    // unused arguments, so the discarded `price` binding is a lint error.
    const noPrice = { ...water };
    delete noPrice.price;
    expect(issueFor(create, noPrice, 'price')).toMatch(/required/i);
  });

  it('rejects more precision than the column holds', () => {
    // Decimal(10,2). Postgres would silently round this one.
    expect(create.safeParse({ ...water, price: '60.123' }).success).toBe(false);
  });

  it('rejects more digits than the column holds', () => {
    // Nine before the point: Decimal(10,2) allows eight. Caught here as a 400
    // rather than reaching Postgres as an unmapped numeric field overflow.
    expect(create.safeParse({ ...water, price: '123456789' }).success).toBe(
      false
    );
  });

  it('rejects negative and zero prices', () => {
    expect(create.safeParse({ ...water, price: '-5' }).success).toBe(false);
    for (const zero of ['0', '0.0', '0.00']) {
      const message = issueFor(create, { ...water, price: zero }, 'price');
      expect(message, zero).toMatch(/greater than zero/i);
    }
  });
});

describe('capacity', () => {
  it('requires a real capacity on a water product', () => {
    expect(issueFor(create, { name: 'A', price: '60' }, 'capacityMl')).toMatch(
      /needs a capacity/i
    );
    expect(
      issueFor(create, { name: 'A', price: '60', capacityMl: 0 }, 'capacityMl')
    ).toMatch(/needs a capacity/i);
  });

  it('lets a deposit omit it', () => {
    const result = create.safeParse({
      name: 'Jar Deposit',
      price: '200.00',
      isDeposit: true,
    });
    expect(result.success).toBe(true);
    // Left undefined here; the controller stores 0.
    expect(result.data.capacityMl).toBeUndefined();
  });

  it('rejects fractional millilitres', () => {
    expect(create.safeParse({ ...water, capacityMl: 1.5 }).success).toBe(false);
  });
});

describe('imageUrl', () => {
  it('accepts https', () => {
    expect(
      create.safeParse({ ...water, imageUrl: 'https://cdn.example.com/a.png' })
        .success
    ).toBe(true);
  });

  it('rejects http, because the browser would silently drop the image', () => {
    expect(
      issueFor(
        create,
        { ...water, imageUrl: 'http://cdn.example.com/a.png' },
        'imageUrl'
      )
    ).toMatch(/https/i);
  });

  it('reports one issue for a non-URL, not two', () => {
    const result = create.safeParse({ ...water, imageUrl: 'jar.png' });
    const issues = result.error.issues.filter(
      (i) => i.path.join('.') === 'imageUrl'
    );
    expect(issues).toHaveLength(1);
  });
});

describe('depositProductId', () => {
  const DEPOSIT_ID = '11111111-0000-4000-8000-000000000003';

  // The case this whole field exists for.
  it('is optional — a disposable product carries no deposit', () => {
    const result = create.safeParse({
      name: '1L Bottle Pack (12)',
      capacityMl: 12000,
      price: '120.00',
    });
    expect(result.success).toBe(true);
    expect(result.data.depositProductId).toBeUndefined();
  });

  it('accepts a uuid', () => {
    const result = create.parse({ ...water, depositProductId: DEPOSIT_ID });
    expect(result.depositProductId).toBe(DEPOSIT_ID);
  });

  it('rejects a non-uuid', () => {
    expect(
      create.safeParse({ ...water, depositProductId: 'the-jar-one' }).success
    ).toBe(false);
  });

  it('refuses to give a deposit its own deposit', () => {
    // Chainable deposits would mean every sum in orders has to decide how far
    // to follow the chain.
    const message = issueFor(
      create,
      {
        name: 'Jar Deposit',
        price: '300.00',
        isDeposit: true,
        depositProductId: DEPOSIT_ID,
      },
      'depositProductId'
    );
    expect(message).toMatch(/cannot itself carry a deposit/i);
  });

  it('can be cleared on update', () => {
    // How you say "this product no longer needs a deposit".
    expect(
      update.parse({ depositProductId: null }).depositProductId
    ).toBeNull();
  });
});

describe('nested deposit on create', () => {
  const DEPOSIT_ID = '11111111-0000-4000-8000-000000000003';

  it('accepts a deposit to create alongside the product', () => {
    const result = create.parse({
      ...water,
      deposit: { price: '250.00' },
    });
    // name and capacityMl are optional — the controller derives them from the
    // product being created.
    expect(result.deposit).toEqual({ price: '250.00' });
  });

  it('validates the nested price with the same rules', () => {
    // Not a second, looser money check. Same schema object.
    expect(
      create.safeParse({ ...water, deposit: { price: 250 } }).success
    ).toBe(false);
    expect(
      create.safeParse({ ...water, deposit: { price: '250.123' } }).success
    ).toBe(false);
    expect(
      create.safeParse({ ...water, deposit: { price: '0' } }).success
    ).toBe(false);
  });

  it('rejects sending both a link and a new deposit', () => {
    // "reuse this one" and "make a new one" in the same request has no
    // sensible reading.
    const message = issueFor(
      create,
      { ...water, depositProductId: DEPOSIT_ID, deposit: { price: '250.00' } },
      'deposit'
    );
    expect(message).toMatch(/not both/i);
  });

  it('refuses to nest a deposit under a deposit', () => {
    const message = issueFor(
      create,
      {
        name: 'Jar Deposit',
        price: '300.00',
        isDeposit: true,
        deposit: { price: '250.00' },
      },
      'deposit'
    );
    expect(message).toMatch(/cannot itself carry a deposit/i);
  });
});

describe('create body', () => {
  it('strips unknown keys rather than storing them', () => {
    // z.object, not strictObject: this is what stops a client slipping an extra
    // column into the Prisma write.
    const result = create.parse({ ...water, isDeposit: false, hacked: true });
    expect(result).not.toHaveProperty('hacked');
  });

  it('defaults to a draft, non-deposit product', () => {
    const result = create.parse(water);
    // Drafts by default. A product reaches the catalogue through an explicit
    // PATCH { isActive: true }, which is the only path the deposit check runs
    // on — creating live would skip it entirely.
    expect(result.isActive).toBe(false);
    expect(result.isDeposit).toBe(false);
  });
});

describe('update body', () => {
  it('rejects an empty patch instead of succeeding as a no-op', () => {
    expect(update.safeParse({}).success).toBe(false);
  });

  it('surfaces a typo rather than stripping it', () => {
    // strictObject here. Stripping would answer {"isActiv": true} with
    // "provide at least one field", which reads like the request never arrived.
    const result = update.safeParse({ isActiv: true });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error.issues)).toMatch(/isActiv/);
  });

  it('refuses to reclassify water as a deposit', () => {
    expect(issueFor(update, { isDeposit: true }, 'isDeposit')).toMatch(
      /cannot be switched/i
    );
  });

  it('allows clearing a nullable field', () => {
    expect(update.parse({ description: null }).description).toBeNull();
    expect(update.parse({ imageUrl: null }).imageUrl).toBeNull();
  });
});

describe('admin list query', () => {
  // The bug this guards against: z.coerce.boolean() treats every non-empty
  // string as true, so ?isActive=false would mean "active" and the admin
  // filter would silently do the opposite of what it says.
  it('reads false as false', () => {
    expect(query.parse({ isActive: 'false' }).isActive).toBe(false);
    expect(query.parse({ isDeposit: 'false' }).isDeposit).toBe(false);
  });

  it('reads true as true', () => {
    expect(query.parse({ isActive: 'true' }).isActive).toBe(true);
  });

  it('leaves an absent filter undefined, not false', () => {
    // undefined means "no filter" in the controller; false would mean
    // "only inactive" and hide every live product from the admin list.
    expect(query.parse({}).isActive).toBeUndefined();
  });

  it('rejects anything else', () => {
    expect(query.safeParse({ isActive: 'yes' }).success).toBe(false);
    expect(query.safeParse({ isActive: '1' }).success).toBe(false);
  });
});
