import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import { toPublicProduct, toAdminProduct } from './products.serialize.js';

/**
 * Deterministic ordering, used by both listings.
 *
 * Price ascending is the customer-facing order — cheapest first — and it stays
 * stable as products are added, unlike createdAt which reshuffles the list
 * every time someone adds a row.
 *
 * The id tiebreaker is not decoration. Postgres gives no ordering guarantee
 * between rows that tie on the sort key, so two jars at 60.00 can come back in
 * either order on consecutive requests. The customer sees the catalogue
 * flicker between refreshes, and any pagination added later silently drops or
 * duplicates a row across the page boundary.
 */
const PRODUCT_ORDER = [{ price: 'asc' }, { id: 'asc' }];

// Columns the public catalogue is allowed to read. Written out rather than
// selecting the whole row and trimming it afterwards: the field that leaks is
// always the one someone added to the model without remembering this path.
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  description: true,
  capacityMl: true,
  price: true,
  imageUrl: true,
  // Name and price only. The customer needs to see "refundable deposit
  // Rs 300"; nothing else about the deposit row is theirs to read.
  depositProduct: { select: { name: true, price: true } },
};

const ADMIN_FIELDS = {
  ...PUBLIC_FIELDS,
  isDeposit: true,
  isActive: true,
  publishedAt: true,
  depositProductId: true,
  depositProduct: {
    select: { id: true, name: true, price: true, isActive: true },
  },
  createdAt: true,
  updatedAt: true,
};

const ADMIN_COUNTS = {
  _count: { select: { orderItems: true, jarsUsingThis: true } },
};

/**
 * Checks that a depositProductId points at something that can actually serve as
 * a deposit, and throws a 400 naming the problem if it does not.
 *
 * The schema can only check the shape of the id. Everything that matters about
 * it needs a query: a jar pointed at another jar would charge Rs 60 as a
 * "deposit" and hand it back later as money held in trust, and nothing
 * downstream would catch it — OrderItem stores a productId and a price, not an
 * opinion about what kind of thing it was.
 *
 * `selfId` is passed on update so a product cannot be made its own deposit.
 */
async function assertUsableDeposit(depositProductId, selfId = null) {
  if (depositProductId === selfId) {
    throw new AppError('A product cannot be its own deposit', 400);
  }

  const deposit = await prisma.product.findUnique({
    where: { id: depositProductId },
    select: { id: true, isDeposit: true, isActive: true, name: true },
  });

  if (!deposit) {
    throw new AppError('That deposit product does not exist', 400);
  }

  if (!deposit.isDeposit) {
    throw new AppError(
      `"${deposit.name}" is not a deposit product. Create one with isDeposit: true, or leave this empty if the product needs no deposit.`,
      400
    );
  }

  if (!deposit.isActive) {
    throw new AppError(
      `"${deposit.name}" is retired and cannot be attached to a product.`,
      400
    );
  }
}

/**
 * Throws a 409 if a product already uses this name.
 *
 * Product.name is UNIQUE at the database level, so this is not the only thing
 * standing between you and a duplicate — it is the thing that explains the
 * duplicate. Do not delete it as redundant.
 *
 * The index cannot say "a RETIRED product already uses this name, find it with
 * ?isActive=false and reactivate it instead". It can only refuse. An admin who
 * gets a bare constraint error goes and creates "20L Water Jar (new)", which is
 * the duplicate they were being stopped from making, under a name nothing will
 * ever catch.
 *
 * The index is what makes the check airtight: two admins submitting the same
 * name at once both read "free" here, and the loser is refused by Postgres and
 * surfaces through the P2002 mapping in errorHandler as the same 409.
 *
 * Case matters and is handled by the column, not by this query. name is
 * @db.Citext, so "20l water jar" and "20L Water Jar" collide in the index as
 * well as in the mode: 'insensitive' lookup below. A plain text column with
 * @@unique would have accepted the pair and left the duplicate this prevents.
 */
async function assertNameIsFree(name, excludeId = null) {
  const existing = await prisma.product.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      // On update the row is compared against itself, so saving a form that did
      // not change the name would 409 against its own record.
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, isActive: true },
  });

  if (!existing) return;

  // A retired product keeps its name and still collides, and that is the likely
  // cause. Sending an admin hunting for a row that is not in their default view
  // is how you get the duplicate anyway, under a slightly different name.
  throw new AppError(
    existing.isActive
      ? `A product named "${name}" already exists.`
      : `A retired product already uses the name "${name}". Find it with ?isActive=false and reactivate it instead of adding it again.`,
    409
  );
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * The customer catalogue. No auth — this is the shopping screen.
 *
 * Two filters, both load-bearing:
 *
 * isActive: true — a retired product must not be orderable, and soft delete is
 * the only kind of delete this module does.
 *
 * isDeposit: false — the deposit is not something anyone shops for. A
 * first-time customer who opens the app and sees "Jar Deposit — Rs 200" near
 * the top concludes water costs Rs 200 and closes it. And if she does not tap
 * it, she receives a jar with no deposit paid, which is the failure the deposit
 * exists to prevent. Orders attaches it automatically by the per-jar rule, so
 * it never needs to be shoppable.
 *
 * Reads the database on every call. No cache, deliberately: this is the one
 * endpoint where staleness is money. A per-instance cache like the one in
 * service-areas goes stale on the OTHER instances after a price change — they
 * keep serving Rs 60 for up to the TTL while orders charges Rs 65, and the
 * customer has a screenshot of the old price. Service areas survive that
 * because a stale answer there is re-checked at two later gates. A stale price
 * is re-checked nowhere.
 */
export async function listPublicProductsHandler(req, res) {
  const products = await prisma.product.findMany({
    where: { isActive: true, isDeposit: false },
    orderBy: PRODUCT_ORDER,
    select: PUBLIC_FIELDS,
  });

  // `data` is the array itself, matching service-areas. The rule the handoff
  // cares about is that the RESPONSE is never a bare array — when paging
  // arrives it goes in as a sibling `meta` key, so this shape does not change
  // and no client has to be rewritten.
  res.status(200).json({ success: true, data: products.map(toPublicProduct) });
}

/**
 * One product, for the customer. No auth — this is the detail screen, and the
 * target of any share link or push notification that names a product.
 *
 * The same two filters as the catalogue, and for the same reasons: a retired
 * product must not be orderable, and a deposit is not a thing anyone shops for.
 * They are in the WHERE rather than applied to the row afterwards, so the query
 * cannot return something this handler then has to remember to hide.
 *
 * findFirst, not findUnique: findUnique only accepts unique columns in `where`,
 * so the filters could not be part of the lookup and would have to be checked
 * after the fact — which is exactly the shape of mistake this avoids.
 *
 * One 404, three causes: no such id, retired, or a deposit row. Telling them
 * apart would turn this into an oracle — walk uuids and the response tells you
 * which products exist and which you have retired. "Not found" is the honest
 * answer to all three anyway; from the customer's side there is nothing there.
 */
export async function getPublicProductHandler(req, res) {
  const { id } = req.valid.params;

  const product = await prisma.product.findFirst({
    where: { id, isActive: true, isDeposit: false },
    select: PUBLIC_FIELDS,
  });

  if (!product) {
    throw new AppError('Product not found', 404);
  }

  res.status(200).json({ success: true, data: toPublicProduct(product) });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * Everything: retired rows, deposit rows, both.
 *
 * An admin who cannot see a retired product cannot bring it back, and one who
 * cannot see the deposit row cannot change what a deposit costs.
 */
export async function listProductsHandler(req, res) {
  const { isActive, isDeposit, search } = req.valid.query;

  const products = await prisma.product.findMany({
    where: {
      ...(isActive === undefined ? {} : { isActive }),
      ...(isDeposit === undefined ? {} : { isDeposit }),
      // insensitive because nobody types "20L Water Jar" with the same
      // capitalisation twice.
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    },
    orderBy: PRODUCT_ORDER,
    // The counts, not the rows: how many order lines point at this product,
    // and how many products point at it as their deposit.
    select: { ...ADMIN_FIELDS, ...ADMIN_COUNTS },
  });

  res.status(200).json({ success: true, data: products.map(toAdminProduct) });
}

/** One product, with the same order count attached. */
export async function getProductHandler(req, res) {
  const { id } = req.valid.params;

  const product = await prisma.product.findUnique({
    where: { id },
    select: { ...ADMIN_FIELDS, ...ADMIN_COUNTS },
  });

  if (!product) {
    throw new AppError('Product not found', 404);
  }

  res.status(200).json({ success: true, data: toAdminProduct(product) });
}

/**
 * Adds a product to the catalogue.
 *
 * Created as a draft unless the caller asks otherwise, so nothing reaches the
 * catalogue without going through publish — which is where the deposit is
 * re-checked. See the isActive note in products.schema.js.
 *
 * The duplicate-name pre-check is here for the message, not the guarantee; the
 * unique index on name is the guarantee. See assertNameIsFree above.
 */
export async function createProductHandler(req, res) {
  const {
    name,
    description,
    capacityMl,
    price,
    isDeposit,
    depositProductId,
    deposit,
    imageUrl,
    isActive,
  } = req.valid.body;

  if (depositProductId) {
    await assertUsableDeposit(depositProductId);
  }

  await assertNameIsFree(name);

  // Defaults for a nested deposit, derived from the product it belongs to.
  //
  // name: "15L Water Jar" -> "15L Water Jar Deposit". Typing it again is a
  // chance to typo it, and the name is the only thing an admin has to
  // recognise the row by in the deposit dropdown later.
  //
  // capacityMl: inherited. Meaningless as a volume on a deposit row, but it is
  // what tells a 20L deposit apart from a 10L one once there are two.
  //
  // isActive: always live, even when the jar is a draft. A deposit is never
  // customer-visible on its own — the catalogue filters isDeposit — so there is
  // nothing to stage, and a jar published later must find its deposit usable.
  // publishedAt follows from that: live on creation means published on
  // creation, the same rule productData applies below. These two move together;
  // changing one without the other is what left deposits reading as unpublished.
  const nestedDepositData = deposit
    ? {
        name: deposit.name ?? `${name} Deposit`,
        description: deposit.description ?? null,
        capacityMl: deposit.capacityMl ?? capacityMl ?? 0,
        price: deposit.price,
        imageUrl: deposit.imageUrl ?? null,
        isDeposit: true,
        isActive: true,
        publishedAt: new Date(),
      }
    : null;

  if (nestedDepositData) {
    await assertNameIsFree(nestedDepositData.name);
  }

  const productData = {
    name,
    description: description ?? null,
    // A deposit row has no meaningful capacity — it is money held in trust,
    // not a volume of water. 0 rather than null so the column stays
    // non-null; anything rendering capacity must filter deposits out first.
    capacityMl: capacityMl ?? 0,
    // String, straight through. See the money note in products.schema.js.
    price,
    isDeposit,
    // null means "carries no deposit", and that is a real product, not a
    // field someone forgot: a 1L bottle pack is disposable, so nothing comes
    // back and there is nothing to hold in trust.
    depositProductId: depositProductId ?? null,
    imageUrl: imageUrl ?? null,
    isActive,
    // A row created live has been published, by definition. Without this the
    // seed and any bulk import would read as DRAFT forever.
    publishedAt: isActive ? new Date() : null,
  };

  // Both rows or neither.
  //
  // Without the transaction, the deposit can be created and the product insert
  // then fail, leaving an orphan deposit attached to nothing. Worse in the
  // other direction on a retry: the admin resubmits, the deposit name now
  // collides with the orphan, and they get a 409 for a product that does not
  // exist yet.
  const product = nestedDepositData
    ? await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: nestedDepositData,
          select: { id: true },
        });

        return tx.product.create({
          data: { ...productData, depositProductId: created.id },
          select: ADMIN_FIELDS,
        });
      })
    : await prisma.product.create({
        data: productData,
        select: ADMIN_FIELDS,
      });

  res.status(201).json({ success: true, data: toAdminProduct(product) });
}

/**
 * Edits a product, including its price.
 *
 * Changing a price is safe because OrderItem.unitPrice is copied at order time
 * rather than joined at read time — an order placed at Rs 60 still reads Rs 60
 * after the catalogue moves to Rs 65. That copy is what makes this handler
 * boring, and it is worth not undoing later.
 */
export async function updateProductHandler(req, res) {
  const { id } = req.valid.params;
  const data = req.valid.body;

  /**
   * Three rules create enforces that update has to enforce too.
   *
   * Each was originally written only where the risk was obvious, which left the
   * same bad states reachable by editing instead of creating — a product born
   * correct stayed correct, a product edited into it did not. That matters more
   * now that products are created as drafts: publishing is PATCH
   * { isActive: true }, so this handler is how every product reaches customers.
   *
   * All three need the row being edited, so they share one read. It is only
   * taken when something actually needs checking, so the common edits — a
   * price, a description, an image — stay a single statement.
   */
  const needsCurrentRow =
    data.isActive === true ||
    Boolean(data.depositProductId) ||
    data.name !== undefined;

  if (needsCurrentRow) {
    const current = await prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        isDeposit: true,
        depositProductId: true,
        publishedAt: true,
      },
    });

    // findUnique returns null rather than throwing. Without this the handler
    // falls through to update() and surfaces P2025 — the right status, but only
    // by accident, and after the checks below have read undefined fields.
    if (!current) {
      throw new AppError('Product not found', 404);
    }

    // A deposit does not carry a deposit. Create refuses this through a schema
    // refine; without the same rule here it only holds for rows that were born
    // correct. Blocking it also closes the cycle case — a row that can never
    // hold a link cannot be part of a loop, which self-reference alone never
    // caught beyond one hop.
    if (current.isDeposit && data.depositProductId) {
      throw new AppError(
        'A deposit product cannot itself carry a deposit',
        400
      );
    }

    // Switching a product on re-opens its catalogue entry, so its deposit has
    // to still be usable. A staged product does not block a deposit being
    // retired — deactivateProductHandler counts only active products, which is
    // correct there — so the deposit may well have gone while this row sat in
    // drafts. Without this check it goes live advertising a retired deposit.
    //
    // Presence, not value. `??` would fall through on an explicit null exactly
    // as it does on an absent key, so "publish this and drop its deposit" would
    // be read as "publish this with its existing deposit" — and refused if that
    // deposit is the retired one being removed.
    const effectiveDeposit =
      'depositProductId' in data
        ? data.depositProductId
        : current.depositProductId;
    if (data.isActive === true && effectiveDeposit) {
      await assertUsableDeposit(effectiveDeposit, id);
    } else if (data.depositProductId) {
      // Changing the link on a row that is not being published still has to
      // point somewhere real.
      await assertUsableDeposit(data.depositProductId, id);
    }

    if (data.name !== undefined) {
      await assertNameIsFree(data.name, id);
    }

    // Stamped on the FIRST publish only. Re-activating something that was
    // retired must not rewrite the date — it did go live back then, and that is
    // what separates a retired product from one still sitting in drafts.
    if (data.isActive === true && !current.publishedAt) {
      data.publishedAt = new Date();
    }
  }

  // P2025 when the id does not exist, which errorHandler turns into a 404.
  const product = await prisma.product.update({
    where: { id },
    data,
    select: ADMIN_FIELDS,
  });

  res.status(200).json({ success: true, data: toAdminProduct(product) });
}

/**
 * DELETE deactivates. It does not delete.
 *
 * Stronger here than in service-areas. OrderItem.productId is a required
 * foreign key with onDelete: Restrict, so a real delete on a product that has
 * ever been ordered does not quietly break anything — Postgres refuses it
 * outright. Which sounds safe, and is exactly the problem: the button would
 * work on the products nobody bought and fail with a foreign key error on the
 * ones that matter, so the behaviour an admin learns from it is the wrong one.
 *
 * A product with no order history could genuinely be deleted. It is not,
 * because then DELETE means two different things depending on data the admin
 * cannot see, and "why did that one vanish and this one didn't" is not a
 * question worth creating.
 *
 * The route stays DELETE because that is what the admin UI's delete button
 * calls, and the customer-visible effect is identical: the product leaves the
 * catalogue. The row survives, with its order history intact.
 */
export async function deactivateProductHandler(req, res) {
  const { id } = req.valid.params;

  // A deposit that live products still point at cannot be retired.
  //
  // Nothing would break loudly if it could. The jars would keep selling, and
  // orders would keep reading a deposit row marked inactive — either charging
  // a retired price or charging nothing, depending on how carefully it looks.
  // Jars would go out the door with no deposit held, and the first sign of it
  // would be jars not coming back weeks later.
  //
  // Refusing forces the right order: create the new deposit, repoint the jars,
  // then retire the old one. That is also exactly how a price rise should go,
  // since the old rows must survive for customers who paid the old amount.
  const linkedCount = await prisma.product.count({
    where: { depositProductId: id, isActive: true },
  });

  if (linkedCount > 0) {
    throw new AppError(
      `This deposit is still attached to ${linkedCount} active product(s). Point them at a different deposit first, or clear it if they no longer need one.`,
      409
    );
  }

  const product = await prisma.product.update({
    where: { id },
    data: { isActive: false },
    select: ADMIN_FIELDS,
  });

  res.status(200).json({
    success: true,
    message: 'Product deactivated',
    data: toAdminProduct(product),
  });
}
