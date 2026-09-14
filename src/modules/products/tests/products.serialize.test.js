import { describe, it, expect } from 'vitest';
import {
  formatPrice,
  toPublicProduct,
  toAdminProduct,
  productStatus,
} from '../products.serialize.js';

// No mocks and no app. Nothing in products.serialize.js touches prisma, env or
// express, which is the point of it being its own file — the money handling is
// the fiddliest part of this module and it is testable without a database.

/**
 * Stands in for Prisma's Decimal.
 *
 * Only toFixed matters to the code under test. Building a real Decimal would
 * mean importing the Prisma client, which pulls in the generated bindings and
 * turns a pure test into one that needs a schema.
 */
function fakeDecimal(text) {
  return {
    toFixed: (places) => {
      const [whole, fraction = ''] = text.split('.');
      return `${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
    },
    toString: () => text,
  };
}

describe('formatPrice', () => {
  it('uses toFixed when given a Decimal', () => {
    expect(formatPrice(fakeDecimal('60'))).toBe('60.00');
    expect(formatPrice(fakeDecimal('60.5'))).toBe('60.50');
    expect(formatPrice(fakeDecimal('1234.99'))).toBe('1234.99');
  });

  // The string branch exists because driver adapters have changed which of the
  // two comes back. Both paths must produce the same answer, or the response
  // shape depends on a Prisma minor version.
  it('pads a plain string to two places', () => {
    expect(formatPrice('60')).toBe('60.00');
    expect(formatPrice('60.5')).toBe('60.50');
    expect(formatPrice('60.50')).toBe('60.50');
    expect(formatPrice('0.05')).toBe('0.05');
  });

  it('agrees with the Decimal branch on every value', () => {
    for (const text of ['0.05', '40', '60.5', '99999999.99']) {
      expect(formatPrice(text)).toBe(formatPrice(fakeDecimal(text)));
    }
  });

  it('does not go through a JS number', () => {
    // 60.10 as a float is 60.099999999999994. Anything that parsed this value
    // rather than treating it as text would show it here.
    expect(formatPrice('60.10')).toBe('60.10');
    // Nine significant digits — past the point where a float stays exact for
    // two decimal places, and past Decimal(10,2) too, but the formatter should
    // not be the thing that mangles it.
    expect(formatPrice('99999999.99')).toBe('99999999.99');
  });

  it('returns null rather than the string "null"', () => {
    expect(formatPrice(null)).toBeNull();
    expect(formatPrice(undefined)).toBeNull();
  });
});

describe('toPublicProduct', () => {
  const row = {
    id: 'p1',
    name: '20L Water Jar',
    description: 'Standard 20 litre jar, refill only',
    capacityMl: 20000,
    price: fakeDecimal('60'),
    imageUrl: 'https://cdn.example.com/jar20.jpg',
  };

  it('formats the price', () => {
    expect(toPublicProduct(row).price).toBe('60.00');
  });

  // The whole reason for an explicit shape rather than spreading the row.
  it('ships no flags a client could mistake for the filter', () => {
    const result = toPublicProduct({
      ...row,
      isDeposit: false,
      isActive: true,
    });

    expect(result).not.toHaveProperty('isDeposit');
    expect(result).not.toHaveProperty('isActive');
    expect(Object.keys(result).sort()).toEqual([
      'capacityMl',
      'deposit',
      'description',
      'id',
      'imageUrl',
      'name',
      'price',
    ]);
  });
});

describe('toPublicProduct deposit', () => {
  const jar = {
    id: 'p1',
    name: '20L Water Jar',
    description: null,
    capacityMl: 20000,
    price: fakeDecimal('60'),
    imageUrl: null,
  };

  it('formats the deposit amount like any other price', () => {
    const result = toPublicProduct({
      ...jar,
      depositProduct: { name: 'Jar Deposit', price: fakeDecimal('300') },
    });

    expect(result.deposit).toEqual({ name: 'Jar Deposit', amount: '300.00' });
  });

  // The 1L bottle pack: disposable, nothing to bring back, nothing held.
  it('is null when the product carries no deposit', () => {
    expect(
      toPublicProduct({ ...jar, depositProduct: null }).deposit
    ).toBeNull();
  });

  it('is null rather than undefined when the query did not join it', () => {
    // A key that is sometimes null and sometimes missing makes the client
    // handle two shapes for one meaning.
    expect(toPublicProduct(jar).deposit).toBeNull();
  });
});

describe('productStatus', () => {
  // isActive alone collapses two states into one value. These three cases are
  // the whole reason publishedAt exists.
  it('is LIVE while active', () => {
    expect(productStatus({ isActive: true, publishedAt: new Date() })).toBe(
      'LIVE'
    );
  });

  it('is DRAFT when it has never been published', () => {
    expect(productStatus({ isActive: false, publishedAt: null })).toBe('DRAFT');
  });

  it('is RETIRED when it was published and then switched off', () => {
    expect(
      productStatus({ isActive: false, publishedAt: new Date('2026-01-01') })
    ).toBe('RETIRED');
  });

  it('stays LIVE even if publishedAt is somehow missing', () => {
    // Defensive: a row active with no stamp is odd, but it is visibly for sale,
    // and reporting DRAFT for something a customer can buy would be the worse
    // of the two wrong answers.
    expect(productStatus({ isActive: true, publishedAt: null })).toBe('LIVE');
  });
});

describe('toAdminProduct', () => {
  const row = {
    id: 'p1',
    name: '20L Water Jar',
    description: null,
    capacityMl: 20000,
    price: fakeDecimal('60'),
    imageUrl: null,
    isDeposit: false,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  it('includes the flags the catalogue hides', () => {
    const result = toAdminProduct(row);

    expect(result.isDeposit).toBe(false);
    expect(result.isActive).toBe(true);
    expect(result.price).toBe('60.00');
  });

  it('carries the derived status so no screen has to work it out', () => {
    expect(toAdminProduct({ ...row, isActive: false }).status).toBe('DRAFT');
    expect(
      toAdminProduct({
        ...row,
        isActive: false,
        publishedAt: new Date('2026-01-01'),
      }).status
    ).toBe('RETIRED');
  });

  it('never leaks status onto the public shape', () => {
    // The catalogue only ever contains LIVE rows, so the field would be a
    // constant — and a client reading it would be trusting the wrong layer to
    // do the filtering.
    expect(toPublicProduct(row)).not.toHaveProperty('status');
  });

  it('flattens Prisma _count into plain numbers', () => {
    const result = toAdminProduct({
      ...row,
      _count: { orderItems: 214, jarsUsingThis: 0 },
    });

    expect(result.orderItemCount).toBe(214);
    expect(result.linkedProductCount).toBe(0);
    // _count is Prisma's shape, not the API's — it must not reach the client.
    expect(result).not.toHaveProperty('_count');
  });

  it('exposes both the deposit id and the expanded row', () => {
    // The id binds the admin form's dropdown; the expanded row lets the list
    // show what the link points at without a second request.
    const result = toAdminProduct({
      ...row,
      depositProductId: 'd1',
      depositProduct: {
        id: 'd1',
        name: 'Jar Deposit',
        price: fakeDecimal('300'),
        isActive: true,
      },
    });

    expect(result.depositProductId).toBe('d1');
    expect(result.deposit).toEqual({
      id: 'd1',
      name: 'Jar Deposit',
      price: '300.00',
      isActive: true,
    });
  });

  it('reports no deposit as null on both keys', () => {
    const result = toAdminProduct(row);
    expect(result.depositProductId).toBeNull();
    expect(result.deposit).toBeNull();
  });

  it('omits the counts when the query did not ask for them', () => {
    // Create and update do not count order items, and a key that is sometimes
    // a number and sometimes undefined is worse for the client than a key that
    // is sometimes absent.
    expect(toAdminProduct(row)).not.toHaveProperty('orderItemCount');
  });
});
