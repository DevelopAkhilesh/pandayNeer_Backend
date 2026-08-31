import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';

const OTP_EXPIRY_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const SALT_ROUNDS = 10;
const MIN_SECONDS_BETWEEN_REQUESTS = 60; // per-phone cooldown

function generateOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Normalizes phone input to a consistent 10-digit Indian mobile format,
 * regardless of how the client sends it (+91, 91 prefix, spaces, dashes).
 */
export function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;

  const digitsOnly = rawPhone.replace(/\D/g, '');

  // Strip a leading country code (91) if present, leaving the 10-digit number
  const normalized =
    digitsOnly.length === 12 && digitsOnly.startsWith('91')
      ? digitsOnly.slice(2)
      : digitsOnly;

  return normalized.length === 10 ? normalized : null;
}

/**
 * Sends the OTP to the given phone number.
 * NOTE: SMS provider (MSG91) is not wired up yet — this currently
 * only logs the OTP to the console for local development/testing.
 * Replace the console.log below with a real MSG91 API call later.
 */
async function sendOtpSms(phone, otp) {
  console.log(`📱 [DEV ONLY] OTP for ${phone}: ${otp}`);
  // TODO: integrate MSG91 here, e.g.:
  // await axios.post('https://control.msg91.com/api/v5/otp', { ... })
}
// request otp function 
export async function requestOtp(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw new AppError('A valid 10-digit phone number is required', 400);
  }

  const now = new Date();

  // Per-phone cooldown: block rapid-fire repeat requests regardless of IP.
  const recentRequest = await prisma.otpRequest.findFirst({
    where: {
      phone,
      createdAt: { gt: new Date(now.getTime() - MIN_SECONDS_BETWEEN_REQUESTS * 1000) },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (recentRequest) {
    throw new AppError(
      `Please wait before requesting another OTP`,
      429
    );
  }

  // Invalidate any older unverified OTPs for this phone by expiring them
  // immediately, so exactly one active OTP chain exists at a time.
  // (Deliberately NOT setting verified=true here — that would falsely
  // claim the user completed verification, corrupting analytics on what
  // "verified" actually means.)
  await prisma.otpRequest.updateMany({
    where: { phone, verified: false, expiresAt: { gt: now } },
    data: { expiresAt: now },
  });

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await prisma.otpRequest.create({
    data: { phone, otpHash, expiresAt },
  });

  await sendOtpSms(phone, otp);
}
// verufy otp function for verification
export async function verifyOtp(rawPhone, otp) {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw new AppError('A valid 10-digit phone number is required', 400);
  }

  const now = new Date();

  const record = await prisma.otpRequest.findFirst({
    where: { phone, verified: false, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    throw new AppError('No valid OTP request found. Please request a new one', 400);
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new AppError('Too many incorrect attempts. Please request a new OTP', 429);
  }

  const isMatch = await bcrypt.compare(otp, record.otpHash);

  if (!isMatch) {
    // Atomic, guarded increment — avoids the read-then-write race entirely.
    // If two requests race here, both WHERE clauses still evaluate against
    // the DB's current row state at the moment each UPDATE executes,
    // so attempts can never under-count under concurrent wrong guesses.
    await prisma.otpRequest.updateMany({
      where: { id: record.id, attempts: { lt: MAX_VERIFY_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    throw new AppError('Invalid OTP', 400);
  }

  await prisma.otpRequest.update({
    where: { id: record.id },
    data: { verified: true },
  });
}