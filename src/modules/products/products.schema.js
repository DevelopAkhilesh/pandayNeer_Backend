import { z } from 'zod';

/**
 * Money.
 *
 * price is Decimal(10,2) in Postgres and is handed to Prisma as a STRING, per
 * the money rule in the conventions. A JS float round-trips through binary
 * floating point, so 60.10 becomes 60.099999999999994 somewhere between the
 * client and the column. Nothing in this file converts the value — it is
 * validated as text and passed on as text. There is no parseFloat here, and
 * there should never be one.
 *
 * Decimal(10,2) is ten significant digits with two after the point, so at most
 * eight before it. The regex enforces that shape rather than leaving Postgres
 * to raise a numeric field overflow, which arrives as an unmapped 500 rather
 * than a 400 naming the field.
 *
 * "60.5" is accepted and stored as 60.50. One decimal place is a normal way to
 * type half a rupee, not a mistake worth rejecting.
 */
export const PRICE_REGEX = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;

// The zero test is a string match, not Number(value) > 0, for the same reason
// the value is a string in the first place. "0", "0.0" and "0.00" are the only
// ways the regex above can express zero.
const ZERO_PRICE_REGEX = /^0(\.0{1,2})?$/;

const price = z
  .string({
    // A function, not a flat message, because the likely mistake here is not a
    // missing field — it is `"price": 60`, a client that JSON-encoded the
    // number it had. A flat message answers that with "Price is required" for a
    // value that was plainly sent, and the client author goes looking in the
    // wrong place. Say what is actually wrong instead.
    error: (issue) =>
      issue.input === undefined
        ? 'Price is required'
        : 'Price must be sent as a string, like "60.00" — a JSON number loses precision before it reaches the database',
  })
  .trim()
  .regex(
    PRICE_REGEX,
    'Enter a price like 60 or 60.50 — up to two decimal places'
  )
  .refine(
    (value) => !ZERO_PRICE_REGEX.test(value),
    'Price must be greater than zero. To take a product off sale, deactivate it instead of pricing it at zero.'
  );

const name = z
  .string({ message: 'Product name is required' })
  .trim()
  .min(1, 'Product name cannot be empty')
  .max(100, 'Product name is too long');

// Nullable so a description can be cleared, but an empty string is not the same
// as "no description" and is rejected rather than quietly stored — same rule as
// areaName in service-areas.
const description = z
  .string()
  .trim()
  .min(1, 'Description cannot be empty')
  .max(500, 'Description is too long');

/**
 * Capacity in millilitres, so 20L is 20000 and there is never a fractional
 * litre to store.
 *
 * The upper bound is a typo guard, not a business rule: 1,000,000 ml is a
 * thousand litres, and anything past that is someone entering millilitres
 * where they meant litres or adding a digit.
 */
const capacityMl = z
  .number({ message: 'Capacity must be a number of millilitres' })
  .int('Capacity must be a whole number of millilitres')
  .min(0, 'Capacity cannot be negative')
  .max(1_000_000, 'Capacity looks wrong — that is over 1000 litres');

/**
 * https only.
 *
 * The customer app is served over https, and a browser silently blocks an
 * http image inside an https page. The jar photo just never appears, with
 * nothing in the response to explain it. Rejecting the URL at write time is
 * the only place this is cheap to diagnose.
 */
const imageUrl = z
  .url('Enter a valid image URL')
  .max(2048, 'Image URL is too long')
  .refine((value) => {
    // Zod runs refinements even after the url() check has already failed, so
    // "jar.png" would collect two issues: "enter a valid image URL" and
    // "must start with https". Staying silent on input that is not a URL at
    // all keeps this refinement about the protocol and nothing else.
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return true;
    }
  }, 'Image URL must start with https:// — browsers block http images on an https page');

/**
 * The deposit this product carries.
 *
 * null is a first-class answer, not an empty field. A 1L bottle pack is
 * disposable — nothing comes back, so nothing is held in trust. Omitting the
 * field on create and sending null on update both mean "no deposit", and the
 * catalogue says so explicitly rather than leaving the client to guess.
 *
 * Only the shape is checked here. Whether the id points at a row that is
 * actually a deposit, and is active, needs a query — that lives in the
 * controller.
 */
const depositProductId = z.uuid('Invalid deposit product id');

// Every write route takes the row id in the path. uuid() rather than a bare
// string so a malformed id returns 400 here instead of reaching Prisma and
// coming back as a confusing 500.
const idParams = z.object({
  id: z.uuid('Invalid product id'),
});

/**
 * GET /api/products  (public)
 *
 * No filters at all. The public catalogue is one fixed list — active, water
 * only — and every knob added here is a knob a client could use to ask for the
 * hidden half. The admin listing is a different route with a different guard.
 */
export const listPublicProductsSchema = {};

/**
 * GET /api/products/:id  (public)
 *
 * The product detail screen, and whatever the app deep-links to from a share
 * sheet or a notification. Same id shape as the admin route — the difference is
 * not what may be asked for, it is what may be answered, and that lives in the
 * controller's WHERE clause.
 */
export const getPublicProductSchema = { params: idParams };

/**
 * GET /api/products/admin  (admin)
 *
 * All filters optional. Query strings arrive as strings, so the booleans are
 * parsed from the two literals rather than z.coerce.boolean() — which treats
 * every non-empty string as true and would make ?isActive=false mean "active".
 */
const booleanQueryFilter = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const listProductsSchema = {
  query: z.object({
    isActive: booleanQueryFilter,
    // Lets an admin pull up the deposit rows on their own, which is the only
    // screen they are visible from.
    isDeposit: booleanQueryFilter,
    // Partial name match, for the admin search box.
    search: z.string().trim().max(100).optional(),
  }),
};

/** GET /api/products/:id  (admin) */
export const getProductSchema = { params: idParams };

/**
 * A deposit to create alongside the product, in the same request.
 *
 * Exists because the two-step version — create the deposit, copy its id, create
 * the jar — has a bad failure mode: step one succeeds, step two is forgotten or
 * fails, and you are left with a deposit row attached to nothing, or a jar
 * selling with no deposit held. The second one is invisible until jars stop
 * coming back.
 *
 * name and capacityMl are optional because they are almost always derivable
 * from the product being created. The controller fills them in.
 */
const nestedDeposit = z.object({
  name: name.optional(),
  description: description.optional(),
  capacityMl: capacityMl.optional(),
  price,
  imageUrl: imageUrl.optional(),
});

/**
 * POST /api/products  (admin)
 *
 * The refine is the one rule worth stating: a water product with no capacity is
 * a listing that cannot say what the customer is buying. A deposit row has no
 * meaningful capacity, so it may omit the field and default to 0 — see the
 * controller.
 */
export const createProductSchema = {
  body: z
    .object({
      name,
      description: description.optional(),
      capacityMl: capacityMl.optional(),
      price,
      isDeposit: z.boolean().optional().default(false),
      // Three ways to express the deposit, and they are mutually exclusive:
      //   omit both          -> no deposit (a disposable bottle pack)
      //   depositProductId   -> reuse an existing deposit row
      //   deposit            -> create a new one and link it, in one request
      depositProductId: depositProductId.optional(),
      deposit: nestedDeposit.optional(),
      imageUrl: imageUrl.optional(),
      // Created as a draft. Publishing is an explicit PATCH { isActive: true },
      // and that is not just a workflow preference: the deposit check lives in
      // the update handler, so a product created live would reach the catalogue
      // without it ever running. Going through publish means every product is
      // checked before a customer can see it.
      isActive: z.boolean().optional().default(false),
    })
    .refine((data) => data.isDeposit || (data.capacityMl ?? 0) > 0, {
      message: 'A water product needs a capacity in millilitres',
      path: ['capacityMl'],
    })
    // A deposit does not carry a deposit. Allowing it would make deposits
    // chainable — a row worth Rs 300 pointing at another worth Rs 300 — and
    // every sum in orders would have to decide how deep to follow the chain.
    // Two refines rather than one covering both fields, so the error names the
    // field the caller actually sent. An issue reported against `deposit` when
    // they sent `depositProductId` sends them looking at the wrong key.
    .refine((data) => !(data.isDeposit && data.depositProductId), {
      message: 'A deposit product cannot itself carry a deposit',
      path: ['depositProductId'],
    })
    .refine((data) => !(data.isDeposit && data.deposit), {
      message: 'A deposit product cannot itself carry a deposit',
      path: ['deposit'],
    })
    // Both at once has no sensible reading — it says "reuse this one" and
    // "make a new one" in the same breath. Rejecting beats picking one and
    // leaving the admin to discover which.
    .refine((data) => !(data.depositProductId && data.deposit), {
      message:
        'Send either depositProductId to reuse an existing deposit, or deposit to create a new one — not both',
      path: ['deposit'],
    }),
};

/**
 * PATCH /api/products/:id  (admin)
 *
 * Price is editable — prices change, and OrderItem.unitPrice is copied at order
 * time, so an old order keeps the price it was placed at.
 *
 * capacityMl is allowed down to 0 here, unlike on create. Re-checking the
 * "water products need a real capacity" rule would mean reading the row first
 * to learn whether it is a deposit, and the cost of a wrong value on an edit is
 * a display bug, not a money bug. Not worth a query on every PATCH.
 */
export const updateProductSchema = {
  params: idParams,
  // strictObject, not object, and the only place in this file that differs.
  // Elsewhere stripping unknown keys is the safe default — it stops a client
  // slipping an extra column into a Prisma write. On a PATCH it hides typos
  // instead: {"isActiv": true} would be stripped to {} and answered with
  // "provide at least one field", which reads like the request never arrived.
  body: z
    .strictObject({
      name: name.optional(),
      description: description.nullable().optional(),
      capacityMl: capacityMl.optional(),
      price: price.optional(),
      imageUrl: imageUrl.nullable().optional(),
      // Nullable so a deposit can be removed. Sending null on a 20L jar is how
      // you say "this no longer needs a deposit"; it is the same field a
      // bottle pack simply never sets.
      depositProductId: depositProductId.nullable().optional(),
      isActive: z.boolean().optional(),
      // Named explicitly so sending it gets a real explanation rather than
      // "unrecognized key".
      //
      // Flipping this is not a rename, it is a reclassification. A water
      // product turned into a deposit vanishes from the public catalogue with
      // no other visible change, and every OrderItem already pointing at it
      // silently becomes a deposit line in the order history. Retire the wrong
      // row and create the right one.
      isDeposit: z
        .never({
          error:
            'A product cannot be switched between water and deposit. Deactivate this one and create the correct product.',
        })
        .optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'Provide at least one field to update',
    }),
};

/** DELETE /api/products/:id  (admin) — deactivates, see the controller. */
export const deactivateProductSchema = { params: idParams };
