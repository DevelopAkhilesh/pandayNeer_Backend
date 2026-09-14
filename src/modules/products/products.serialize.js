/**
 * Turning a Product row into a response body.
 *
 * This exists for one reason: price does not survive res.json() intact.
 *
 * Prisma returns a Decimal(10,2) column as a Decimal instance, and its
 * toString drops trailing zeros. A row stored as 60.00 serialises to "60", and
 * 60.50 to "60.5". The client then renders "Rs 60.5" on the product card, and
 * every screen that shows a price grows its own formatting helper to paper
 * over it.
 *
 * Formatting once, here, means the API's contract is "price is a decimal string
 * with exactly two places" and the client can print it directly.
 *
 * The other reason for a file rather than an inline select: the public and
 * admin shapes differ, and the difference is a security boundary, not a
 * convenience. Deposit rows and retired rows must never reach the public
 * catalogue. That rule is enforced by the WHERE clause in the controller and
 * echoed here by simply not having the fields to leak.
 */

/**
 * Formats a price as a fixed two-decimal string.
 *
 * Accepts a Prisma Decimal or a plain string, because driver adapters have
 * changed which of the two comes back before and may again. Neither path
 * converts to a JS number — the string branch pads text rather than doing
 * arithmetic, for the same reason prices are written as strings on the way in.
 *
 * Returns null for null, so a nullable price column later does not become the
 * string "null" on a product card.
 */
export function formatPrice(value) {
  if (value === null || value === undefined) return null;

  // Prisma Decimal (decimal.js) — toFixed is exact here, not float rounding.
  if (typeof value.toFixed === 'function') return value.toFixed(2);

  const text = String(value).trim();
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * What a customer sees.
 *
 * isDeposit and isActive are deliberately absent rather than present-and-true.
 * Every row that reaches this function is already active water — the flags
 * would be two constants shipped on every product, and a client that started
 * reading them would be trusting the wrong layer to do the filtering.
 */
export function toPublicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    capacityMl: product.capacityMl,
    price: formatPrice(product.price),
    imageUrl: product.imageUrl,
    deposit: toPublicDeposit(product.depositProduct),
  };
}

/**
 * The deposit attached to a product, for the customer.
 *
 * Explicitly null rather than an absent key when there is no deposit. A 1L
 * bottle pack and a 20L jar come back with the same shape, so the client
 * renders "refundable deposit" from the presence of an object instead of
 * hardcoding which products happen to need one.
 *
 * The deposit is still not a shoppable row — it is not in the catalogue list.
 * It is shown here as an attached, labelled amount on the jar it belongs to,
 * which is the opposite problem: a customer who only learns about Rs 300 at
 * checkout abandons the order.
 */
function toPublicDeposit(deposit) {
  if (!deposit) return null;

  return {
    name: deposit.name,
    amount: formatPrice(deposit.price),
  };
}

/**
 * The lifecycle state, derived from isActive and publishedAt.
 *
 * Derived rather than stored, for the same reason jar balances are sums: two
 * sources for one fact drift, and then you are debugging which of them lied.
 * isActive stays the single thing the catalogue query filters on.
 *
 * Exposed as one string because the alternative is every screen writing
 * `!isActive && !publishedAt ? 'Draft' : ...` for itself, and one of them
 * getting it backwards.
 */
export function productStatus({ isActive, publishedAt }) {
  if (isActive) return 'LIVE';
  // Never published: unfinished work, safe to edit freely, no order history.
  if (!publishedAt) return 'DRAFT';
  // Was live, now withdrawn. Orders may reference it; the row is history.
  return 'RETIRED';
}

/**
 * What an admin sees: the same row plus the parts the catalogue hides.
 *
 * orderItemCount is folded in from Prisma's _count when the caller asked for
 * it. It is the number that makes soft delete make sense — "this product is on
 * 214 orders" is the answer to why DELETE only deactivates.
 */
export function toAdminProduct(product) {
  const { _count, ...row } = product;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    capacityMl: row.capacityMl,
    price: formatPrice(row.price),
    imageUrl: row.imageUrl,
    isDeposit: row.isDeposit,
    isActive: row.isActive,
    publishedAt: row.publishedAt ?? null,
    status: productStatus(row),
    // The raw id as well as the expanded row: the admin edit form binds a
    // dropdown to the id, and the list needs the name and price to show what
    // the link actually points at without a second request.
    depositProductId: row.depositProductId ?? null,
    deposit: row.depositProduct
      ? {
          id: row.depositProduct.id,
          name: row.depositProduct.name,
          price: formatPrice(row.depositProduct.price),
          isActive: row.depositProduct.isActive,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(_count
      ? {
          orderItemCount: _count.orderItems,
          // How many products point AT this one. Non-zero on a deposit row
          // means retiring it would leave those jars with no deposit, which is
          // why deactivation refuses — see the controller.
          linkedProductCount: _count.jarsUsingThis,
        }
      : {}),
  };
}
