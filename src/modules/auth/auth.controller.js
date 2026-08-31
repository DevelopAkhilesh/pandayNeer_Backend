import jwt from 'jsonwebtoken';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  requestOtp as sendOtp,
  verifyOtp as checkOtp,
  normalizePhone,
} from './otp.service.js';

function assertValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new AppError('A valid 10-digit phone number is required', 400);
  }
  return normalized;
}

const OTP_REGEX = /^\d{6}$/;

function signToken(user) {
  return jwt.sign(
    { userId: user.id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

export async function requestOtpHandler(req, res) {
  const phone = assertValidPhone(req.body.phone);

  await sendOtp(phone);

  res.status(200).json({
    success: true,
    message: 'OTP sent successfully',
  });
}

export async function verifyOtpHandler(req, res) {
  const phone = assertValidPhone(req.body.phone);
  const { otp, name } = req.body;

  if (!otp || typeof otp !== 'string' || !OTP_REGEX.test(otp)) {
    throw new AppError('OTP must be a 6-digit number', 400);
  }

  await checkOtp(phone, otp);

  // Atomic create-or-fetch. Note: Prisma's upsert is not guaranteed to
  // compile into a single lock-free SQL statement on every provider/config —
  // under true concurrency it can still throw P2002 if another request's
  // create landed a moment earlier. We explicitly catch that specific case
  // and recover by fetching the row that already exists, so two simultaneous
  // logins for a brand-new phone both succeed instead of one erroring.
  let user;
  try {
    user = await prisma.user.upsert({
      where: { phone },
      create: { phone, name, role: 'CUSTOMER' },
      update: {},
    });
  } catch (err) {
    if (err.code === 'P2002') {
      user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    } else {
      throw err;
    }
  }

  // Name updates are handled as a separate step: once the user row is
  // guaranteed to exist, updating it is no longer racy the same way —
  // concurrent updates just resolve last-write-wins, not an error.
  if (name && name !== user.name) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { name },
    });
  }

  if (user.status !== 'ACTIVE') {
    throw new AppError('This account is not active. Please contact support', 403);
  }

  const token = signToken(user);

  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
      },
    },
  });
}