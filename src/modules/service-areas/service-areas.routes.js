import { Router } from 'express';
import rateLimit, { MINUTE } from 'express-rate-limit';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authGuard.js';
import { requireAdmin } from '../../middleware/roleGuard.js';
import { env } from '../../config/env.js';
import {
  checkServiceabilitySchema,
  listServiceAreasSchema,
  getServiceAreaSchema,
  createServiceAreaSchema,
  updateServiceAreaSchema,
  deactivateServiceAreaSchema,
} from './service-areas.schema.js';
import {
  checkServiceabilityHandler,
  listServiceAreasHandler,
  getServiceAreaHandler,
  createServiceAreaHandler,
  updateServiceAreaHandler,
  deactivateServiceAreaHandler,
} from './service-areas.controller.js';

const router = Router();

/**
 * Loose cap on the public check.
 *
 * This is unauthenticated, so it needs some ceiling — but the same
 * carrier-grade NAT problem as the OTP routes applies: hundreds of Jio users
 * can share one public IP, and a tight limit would lock them all out of the
 * app's first screen with no explanation.
 *
 * It is generous because the request is cheap. Answers come from the in-process
 * cache, so this does not touch Postgres at all.
 *
 * Depends on app.set('trust proxy', 1) in app.js, same as the auth routes.
 */
const checkLimiter = rateLimit({
  windowMs: 1 * MINUTE,
  max: env.PUBLIC_RATE_LIMIT_MAX,
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
// MUST stay above '/:id'. Express matches in registration order, so if the
// admin detail route came first, '/check' would be read as an id — and the
// public route would start demanding an admin token.
router.get(
  '/check',
  checkLimiter,
  validate(checkServiceabilitySchema),
  checkServiceabilityHandler
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
// requireAuth then requireAdmin on every route below. Applied per-route rather
// than with router.use so that a reader can see the guard on the line they are
// reading, and so a route added later cannot accidentally inherit or miss it.
router.get(
  '/',
  requireAuth,
  requireAdmin,
  validate(listServiceAreasSchema),
  listServiceAreasHandler
);

router.get(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(getServiceAreaSchema),
  getServiceAreaHandler
);

router.post(
  '/',
  requireAuth,
  requireAdmin,
  validate(createServiceAreaSchema),
  createServiceAreaHandler
);

router.patch(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(updateServiceAreaSchema),
  updateServiceAreaHandler
);

// Deactivates rather than deletes — see the handler for why.
router.delete(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(deactivateServiceAreaSchema),
  deactivateServiceAreaHandler
);

export default router;
