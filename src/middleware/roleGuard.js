import { AppError } from './errorHandler.js';

/**
 * Mirrors the Role enum in prisma/schema.prisma.
 *
 * Routes should reference these rather than bare strings: `requireRole('ADMINN')`
 * is a guard that silently rejects everyone, and it looks exactly like a
 * permissions bug when it happens in production.
 */
export const ROLES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  DELIVERY_BOY: 'DELIVERY_BOY',
  ADMIN: 'ADMIN',
});

const VALID_ROLES = new Set(Object.values(ROLES));

/**
 * Role gate. Must run after requireAuth, which is what populates req.user:
 *
 *   router.get('/admin/orders', requireAuth, requireRole(ROLES.ADMIN), handler)
 *
 * Accepts several roles, either as arguments or as one array:
 *
 *   requireRole(ROLES.ADMIN, ROLES.DELIVERY_BOY)
 *   requireRole([ROLES.ADMIN, ROLES.DELIVERY_BOY])
 */
export function requireRole(...roles) {
  const allowed = roles.flat();

  // Both of these throw at module load, when routes are built — not on the
  // first request. A typo'd role would otherwise ship as a guard that 403s
  // every user, and an empty call as one that 403s them for no stated reason.
  if (allowed.length === 0) {
    throw new Error('requireRole() requires at least one role');
  }
  for (const role of allowed) {
    if (!VALID_ROLES.has(role)) {
      throw new Error(
        `requireRole(): unknown role "${role}". Expected one of: ${[
          ...VALID_ROLES,
        ].join(', ')}`
      );
    }
  }

  const allowedSet = new Set(allowed);

  return function roleGuard(req, res, next) {
    // Fails closed. Mounting this without requireAuth is a wiring mistake, and
    // reading `undefined.role` would otherwise let the request through.
    if (!req.user) {
      throw new AppError('Authentication required', 401);
    }

    if (!allowedSet.has(req.user.role)) {
      // 403, not 404: the caller is authenticated, so hiding the route's
      // existence buys nothing and makes the client harder to debug.
      throw new AppError('You do not have permission to do this', 403);
    }

    next();
  };
}

// The two gates worth naming — admin panels and the delivery app both check
// one role on nearly every route.
export const requireAdmin = requireRole(ROLES.ADMIN);
export const requireDeliveryBoy = requireRole(ROLES.DELIVERY_BOY);
