import jwt from 'jsonwebtoken';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { AppError } from './errorHandler.js';

// Pinned rather than inferred. With a string secret jsonwebtoken already
// restricts itself to HMAC, so this is defence in depth — but it means a later
// switch to an asymmetric key cannot silently start accepting a token whose
// header names an algorithm we never intended.
const JWT_ALGORITHMS = ['HS256'];
const JWT_ISSUER = 'pandeyneer';

// One message for every rejection below. A revoked token, a suspended account
// and a deleted user must be indistinguishable from outside, or the endpoint
// becomes an oracle for which accounts exist and which are banned.
const GENERIC_AUTH_ERROR = 'Session expired. Please log in again';

/**
 * Pulls the bearer token out of the Authorization header.
 *
 * RFC 7235 makes the scheme case-insensitive and real clients do send
 * "bearer", so matching only "Bearer" rejects valid requests. Returns null for
 * anything malformed rather than guessing.
 */
function readBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer' || !token) return null;

  return token;
}

/**
 * Verifies the session token and loads the current user onto `req.user`.
 *
 * Every request hits the database. That is the deliberate cost of revocable
 * sessions: without the lookup, suspending an account or bumping tokenVersion
 * does nothing until the token expires on its own, because the status check in
 * /verify-otp only ever runs at login.
 */
export async function requireAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    throw new AppError('Authentication required', 401);
  }

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: JWT_ALGORITHMS,
      issuer: JWT_ISSUER,
    });
  } catch (err) {
    // Expiry is the one case worth distinguishing: the client should re-login
    // rather than retry, and an expired token proves nothing about the account.
    if (err.name === 'TokenExpiredError') {
      throw new AppError(GENERIC_AUTH_ERROR, 401);
    }
    throw new AppError('Invalid session', 401);
  }

  // A token signed by us always carries these, but a malformed payload would
  // otherwise reach Prisma as `where: { id: undefined }` and throw a 500.
  if (typeof payload.userId !== 'string' || !payload.userId) {
    throw new AppError('Invalid session', 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      phone: true,
      name: true,
      role: true,
      status: true,
      tokenVersion: true,
    },
  });

  // Compared strictly. A token minted before `tv` existed yields
  // `0 !== undefined`, which rejects — the safe direction.
  if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== payload.tv) {
    throw new AppError(GENERIC_AUTH_ERROR, 401);
  }

  req.user = user;
  next();
}
