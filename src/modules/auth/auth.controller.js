import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  requestOtp as sendOtp,
  verifyOtp as checkOtp,
  normalizePhone,
} from './otp.service.js';

const OTP_REGEX = /^\d{6}$/;
const MAX_NAME_LENGTH = 60;

/**
 * The only user shape the client ever sees.
 *
 * requireAuth also loads `status` and `tokenVersion` because it needs them to
 * decide whether a session is still valid. Those are ours. Building the
 * response by hand in three places is how one of them eventually leaks.
 */
function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    role: user.role,
  };
}

/**
 * Which onboarding step is still outstanding, so the app knows what to show.
 *
 * Returned only to an authenticated caller. Asking for a name during
 * /verify-otp instead would mean telling an unauthenticated caller whether a
 * phone number already has an account.
 */
function onboardingState(user) {
  return { hasName: Boolean(user.name) };
}

function assertValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new AppError('A valid 10-digit phone number is required', 400);
  }
  return normalized;
}

/**
 * `name` comes straight from the client and lands in the database. Unbounded,
 * it lets anyone store a multi-megabyte string, and a non-string (an object,
 * an array) throws a raw Prisma error that leaks schema details through your
 * error handler.
 */
function sanitizeName(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new AppError('Name must be text', 400);
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new AppError(
      `Name must be ${MAX_NAME_LENGTH} characters or fewer`,
      400
    );
  }
  return trimmed;
}

/**
 * Signs a session token.
 *
 * `tokenVersion` makes tokens revocable. Without it, suspending an account or
 * responding to a stolen phone does nothing until the existing token expires
 * on its own — the /verify-otp status check only runs at login, never again.
 * Bumping User.tokenVersion invalidates every token that account holds.
 *
 * Your auth middleware must compare the token's `tv` claim against the user's
 * current tokenVersion on each request and reject on mismatch.
 *
 * `jti` gives each token an identity so you can log and trace one session.
 */
function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      role: user.role,
      tv: user.tokenVersion ?? 0,
      jti: crypto.randomUUID(),
    },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_EXPIRES_IN,
      issuer: 'pandeyneer',
      subject: String(user.id),
    }
  );
}

export async function requestOtpHandler(req, res) {
  // req.body is undefined if express.json() did not run or the body was empty,
  // and `undefined.phone` is a TypeError, not a clean 400.
  const body = req.body ?? {};
  const phone = assertValidPhone(body.phone);

  // The IP is what makes the distinct-phone cap in the service work. Requires
  // app.set('trust proxy', 1) or this is the load balancer's address for
  // every single request.
  await sendOtp(phone, { ip: req.ip });

  res.status(200).json({
    success: true,
    message: 'OTP sent successfully',
  });
}

export async function verifyOtpHandler(req, res) {
  const body = req.body ?? {};
  const phone = assertValidPhone(body.phone);
  const { otp } = body;
  const name = sanitizeName(body.name);

  if (typeof otp !== 'string' || !OTP_REGEX.test(otp.trim())) {
    throw new AppError('OTP must be a 6-digit number', 400);
  }

  // Consume the OTP first. Everything below is gated on proof that this caller
  // controls the phone — including whether an account exists for it, which is
  // information we do not hand out to unauthenticated callers.
  await checkOtp(phone, otp.trim());

  let user;
  try {
    user = await prisma.user.upsert({
      where: { phone },
      // `name` is only applied on create. Applying it on update would let any
      // later login silently overwrite the stored name; the explicit update
      // below handles genuine renames, and only for active accounts.
      // Address hangs off CustomerProfile, never off User, so a customer with
      // no profile row structurally cannot hold an address. Creating it here
      // makes "every customer has a profile" an invariant the rest of the app
      // can rely on without a null check.
      create: {
        phone,
        name,
        role: 'CUSTOMER',
        customerProfile: { create: {} },
      },
      update: {},
    });
  } catch (err) {
    // Prisma's upsert is not guaranteed to compile to a single lock-free
    // statement, so two simultaneous first-logins can still collide. Recover by
    // reading the row the other request just created.
    if (err.code === 'P2002') {
      user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    } else {
      throw err;
    }
  }

  // Status check moved ABOVE the name update. In the original order a suspended
  // user could still rewrite their name on the way to being rejected.
  if (user.status !== 'ACTIVE') {
    throw new AppError(
      'This account is not active. Please contact support',
      403
    );
  }

  if (name && name !== user.name) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { name },
    });
  }

  const token = signToken(user);

  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: {
      token,
      user: publicUser(user),
      onboarding: onboardingState(user),
    },
  });
}

/**
 * Sets the display name, collected on the screen shown right after login.
 *
 * Separate from /verify-otp on purpose: requiring a name there, only for new
 * accounts, would tell an unauthenticated caller which phone numbers are
 * already registered.
 */
export async function updateMeHandler(req, res) {
  const body = req.body ?? {};

  // PATCH with nothing to change is a client bug, not a no-op worth pretending
  // succeeded — the app would show "saved" for a name it never sent.
  if (!('name' in body)) {
    throw new AppError('Nothing to update', 400);
  }

  // sanitizeName returns undefined for null, empty, or whitespace-only. On
  // login that means "not supplied"; here the caller is explicitly setting a
  // name, so blank is a mistake rather than an omission.
  const name = sanitizeName(body.name);
  if (!name) {
    throw new AppError('Name is required', 400);
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { name },
  });

  res.status(200).json({
    success: true,
    message: 'Profile updated',
    data: {
      user: publicUser(user),
      onboarding: onboardingState(user),
    },
  });
}

export async function logoutAllHandler(req, res) {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  res.status(200).json({ success: true, message: 'Logged out of all devices' });
}

/**
 * The current session's user.
 *
 * Returns the same shape as /verify-otp rather than `req.user` wholesale.
 * requireAuth also selects `status` and `tokenVersion` because it needs them to
 * decide whether the session is still valid — those are ours, not the client's,
 * and a frontend that starts reading tokenVersion is one we cannot change.
 */
export async function meHandler(req, res) {
  res.status(200).json({
    success: true,
    data: {
      user: publicUser(req.user),
      onboarding: onboardingState(req.user),
    },
  });
}
