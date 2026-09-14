import { Router } from 'express';
import rateLimit, { MINUTE } from 'express-rate-limit';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authGuard.js';
import { requireAdmin } from '../../middleware/roleGuard.js';
import {
  listProductsSchema,
  getProductSchema,
  createProductSchema,
  updateProductSchema,
  deactivateProductSchema,
} from './products.schema.js';
import {
  listPublicProductsHandler,
  listProductsHandler,
  getProductHandler,
  createProductHandler,
  updateProductHandler,
  deactivateProductHandler,
} from './products.controller.js';

const router = Router();

/**
 * Loose cap on the public catalogue.
 *
 * Same carrier-grade NAT reasoning as /service-areas/check: hundreds of Jio
 * users share one public IP, so a tight limit locks all of them out of the
 * shopping screen at once, with no way for any of them to tell why.
 *
 * Matched to that endpoint's 300/min even though this one is more expensive —
 * /check answers from an in-process Map, this queries Postgres on every
 * request. If that ever shows up as load, the fix is not the cache pattern
 * from service-areas; a stale price on a second instance is a wrong number on
 * a customer's screen. Tighten this, add an ETag, or put a CDN in front.
 *
 * Depends on app.set('trust proxy', 1) in app.js, same as the auth routes.
 */
const catalogueLimiter = rateLimit({
  windowMs: 1 * MINUTE,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again in a moment.',
  },
});

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
// The customer catalogue: active water products only, deposit hidden.
//
// No validate() — there is nothing to parse. The public list takes no filters
// on purpose; see the note on listPublicProductsSchema.
router.get('/', catalogueLimiter, listPublicProductsHandler);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
// requireAuth then requireAdmin on every route below. Applied per-route rather
// than with router.use so that a reader sees the guard on the line they are
// reading, and so a route added later cannot accidentally inherit or miss it.

/**
 * The full listing lives at /admin rather than at '/'.
 *
 * The handoff table has both the public catalogue and the admin listing at
 * GET /api/products. That cannot be built as written: Express matches on
 * method and path, so one of the two would shadow the other, and the only way
 * to keep a single path is to branch on whether the caller happens to be an
 * admin. That was rejected — it makes an unauthenticated endpoint's response
 * depend on a header, so the same URL returns a different catalogue to
 * different people, and the guard stops being visible on the route line, which
 * is the convention this codebase is built on.
 *
 * MUST stay above '/:id', exactly like '/check' in service-areas. Express
 * matches in registration order, so if the detail route came first, 'admin'
 * would be read as an id — and here it would not even 404 cleanly, it would
 * fail the uuid check and return "Invalid product id", which is a confusing
 * thing to see on a listing screen.
 */
router.get(
  '/admin',
  requireAuth,
  requireAdmin,
  validate(listProductsSchema),
  listProductsHandler
);

router.get(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(getProductSchema),
  getProductHandler
);

router.post(
  '/',
  requireAuth,
  requireAdmin,
  validate(createProductSchema),
  createProductHandler
);

router.patch(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(updateProductSchema),
  updateProductHandler
);

// Deactivates rather than deletes — see the handler for why.
router.delete(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(deactivateProductSchema),
  deactivateProductHandler
);

export default router;
