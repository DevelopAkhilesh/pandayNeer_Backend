import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import { sendOtpSms } from '../../services/sms/sms.provider.js';

const OTP_EXPIRY_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const SALT_ROUNDS = 10;

/**
 * A real bcrypt hash of a string no OTP can ever equal (OTPs are 6 digits).
 *
 * Purpose is timing, not secrecy. Without it, verifyOtp returns instantly when
 * no pending OTP exists and takes ~100ms when one does — so an attacker who
 * submits a junk code and watches the clock learns whether a given phone
 * number has a live OTP. That is exactly the fact GENERIC_VERIFY_ERROR was
 * written to hide.
 *
 * Generated at boot rather than hardcoded for two reasons: a hardcoded string
 * can be malformed, and bcrypt.compare rejects a malformed hash immediately —
 * which reintroduces the fast path this exists to remove. Deriving it from
 * SALT_ROUNDS also keeps the dummy comparison exactly as expensive as a real
 * one if that constant ever changes.
 *
 * Costs one bcrypt round (~100ms) at startup, once.
 */
const DUMMY_HASH = bcrypt.hashSync('no-otp-matches-this', SALT_ROUNDS);

// Cooldown is a UX guard (stops double-taps). The hourly/daily caps are the
// actual security control: without them an attacker can farm 5 fresh guesses
// per minute forever by simply re-requesting.
const MIN_SECONDS_BETWEEN_REQUESTS = 60;
const MAX_REQUESTS_PER_HOUR = 5;
const MAX_REQUESTS_PER_DAY = 15;

// Per-phone caps cannot stop an attacker who rotates numbers: each number
// stays under its own limit while the SMS bill climbs. This is the actual
// SMS-pumping control.
const MAX_DISTINCT_PHONES_PER_IP_HOUR = 10;

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

// One message for every verify failure — wrong code, expired, consumed,
// attempts exhausted, never existed. Distinct messages would tell an attacker
// whether a pending OTP exists for a given number.
const GENERIC_VERIFY_ERROR = 'Invalid or expired OTP. Please request a new one';

export function generateOtp() {
  // Upper bound is EXCLUSIVE — 1000000, not 999999, or 999999 never occurs.
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Normalizes phone input to a 10-digit Indian mobile number.
 *
 * This is also the implicit country allowlist that protects against SMS
 * pumping fraud (attackers driving traffic to premium international routes).
 * Do not loosen it to accept arbitrary international numbers without adding
 * a separate per-country policy first.
 *
 * Accepts: 9876543210, +91 98765 43210, 91-9876543210, 09876543210,
 *          00919876543210
 * Rejects: anything not starting 6-9, wrong length, non-strings, null.
 */
export function normalizePhone(rawPhone) {
  if (typeof rawPhone !== 'string') return null;

  const digitsOnly = rawPhone.replace(/\D/g, '');
  if (!digitsOnly) return null;

  // Strip leading zeros (trunk prefix / 00 international prefix), then the
  // 91 country code if what remains is 12 digits.
  let normalized = digitsOnly.replace(/^0+/, '');
  if (normalized.length === 12 && normalized.startsWith('91')) {
    normalized = normalized.slice(2);
  }

  return INDIAN_MOBILE.test(normalized) ? normalized : null;
}

export async function requestOtp(rawPhone, { ip = null } = {}) {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw new AppError(
      'A valid 10-digit Indian mobile number is required',
      400
    );
  }

  // Hash outside the transaction — bcrypt at 10 rounds takes ~100ms and we do
  // not want to hold a Serializable transaction open for that long.
  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);

  let created;
  try {
    created = await prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const cooldownSince = new Date(
          now.getTime() - MIN_SECONDS_BETWEEN_REQUESTS * 1000
        );
        const hourSince = new Date(now.getTime() - 60 * 60 * 1000);
        const daySince = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // All three windows in one round trip. As three separate count()
        // calls this cost ~900ms each against a remote database — enough on
        // its own to exceed the transaction timeout before reaching the
        // create below. Conditional aggregates read the same index once.
        // verified:false on the cooldown matters — a user who just logged in
        // successfully and logs out should not be told "please wait".
        const [counts] = await tx.$queryRaw`
          SELECT
            count(*) FILTER (
              WHERE verified = false AND "sendFailed" = false AND "createdAt" > ${cooldownSince}
            ) AS "cooldown",
            count(*) FILTER (WHERE "sendFailed" = false AND "createdAt" > ${hourSince}) AS "hour_count",
            count(*) FILTER (WHERE "sendFailed" = false AND "createdAt" > ${daySince}) AS "day_count",
            (
              SELECT count(DISTINCT phone)
              FROM "OtpRequest"
              WHERE ip = ${ip}
                AND "createdAt" > ${hourSince}
                AND phone <> ${phone}
            ) AS "other_phones_for_ip"
          FROM "OtpRequest"
          WHERE phone = ${phone}
        `;

        // count() returns bigint over the wire; compare as Number.
        if (Number(counts.cooldown) > 0) {
          throw new AppError('Please wait before requesting another OTP', 429);
        }
        if (Number(counts.hour_count) >= MAX_REQUESTS_PER_HOUR) {
          throw new AppError(
            'Too many OTP requests. Please try again later',
            429
          );
        }
        if (Number(counts.day_count) >= MAX_REQUESTS_PER_DAY) {
          throw new AppError(
            'Daily OTP limit reached. Please try again tomorrow',
            429
          );
        }

        // SMS-pumping control. Counting OTHER phones means a user
        // re-requesting for their own number is never affected by it. `ip =
        // NULL` matches nothing in SQL, so a missing IP simply skips the
        // check rather than matching every row with a null ip.
        if (
          Number(counts.other_phones_for_ip) >= MAX_DISTINCT_PHONES_PER_IP_HOUR
        ) {
          throw new AppError(
            'Too many OTP requests. Please try again later',
            429
          );
        }

        // Invalidate older unverified OTPs by expiring them, so exactly one
        // active OTP exists per phone. Deliberately NOT setting verified=true —
        // that would corrupt what "verified" means in analytics.
        await tx.otpRequest.updateMany({
          where: { phone, verified: false, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });

        return tx.otpRequest.create({
          data: {
            phone,
            otpHash,
            ip,
            expiresAt: new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000),
          },
        });
      },
      {
        isolationLevel: 'Serializable',
        // These are Prisma's defaults. Stated explicitly because they were
        // 15s for most of this file's history, and why they no longer need
        // to be is worth keeping.
        //
        // The body is five round trips — BEGIN, the aggregate, the updateMany,
        // the create, COMMIT. Against Supabase ap-south-1 that is ~330ms from
        // a dev laptop (~66ms each) and ~10ms from an API in the same region.
        // Acquisition is no longer a problem either: db.js keeps the pool warm,
        // so the ~490ms cold handshake never lands inside a request.
        //
        // If these ever need raising again the cause is distance or a cold
        // pool, not this transaction. Measure both before changing them.
        maxWait: 2_000,
        timeout: 5_000,
      }
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    // P2034 = Prisma write conflict / deadlock. Under Serializable this is how
    // two genuinely simultaneous requests for the same phone get resolved: one
    // commits, the other aborts. Treat the loser as a cooldown hit.
    if (err?.code === 'P2034') {
      throw new AppError('Please wait before requesting another OTP', 429);
    }
    throw err;
  }

  // Send AFTER commit — never hold a transaction open across network I/O.
  try {
    await sendOtpSms(phone, otp);
  } catch (err) {
    // The caller gets a generic 502, so this log is the only record of why the
    // send actually failed. Phone number only — never the code.
    console.error(`OTP send failed for ${phone}: ${err.message}`);

    // A send failure must NOT return "OTP sent successfully". Expire the row so
    // the user is not stuck in cooldown waiting for a code that never left.
    await prisma.otpRequest.updateMany({
      where: { id: created.id },
      data: { expiresAt: new Date(), sendFailed: true },
    });
    throw new AppError('Could not send OTP right now. Please try again', 502);
  }

  return { expiresAt: created.expiresAt };
}
// verify otp function
export async function verifyOtp(rawPhone, otp) {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw new AppError(
      'A valid 10-digit Indian mobile number is required',
      400
    );
  }

  const code = typeof otp === 'string' ? otp.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    // Cheap reject before touching bcrypt — also stops bcrypt DoS via huge input.
    throw new AppError(GENERIC_VERIFY_ERROR, 400);
  }

  const record = await prisma.otpRequest.findFirst({
    where: {
      phone,
      verified: false,
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_VERIFY_ATTEMPTS },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    // Burn the same ~100ms a real comparison would, so "no pending OTP for
    // this number" and "wrong code for this number" are indistinguishable
    // from outside. The result is discarded — it can never be true.
    //
    // Note this covers four states at once: no OTP was ever requested, it
    // expired, it was already consumed, or its attempts are exhausted. All
    // four must look identical, and now all four also *take* the same time.
    await bcrypt.compare(code, DUMMY_HASH);
    throw new AppError(GENERIC_VERIFY_ERROR, 400);
  }

  const isMatch = await bcrypt.compare(code, record.otpHash);

  if (!isMatch) {
    // Atomic guarded increment — cannot under-count under concurrent guesses.
    await prisma.otpRequest.updateMany({
      where: { id: record.id, attempts: { lt: MAX_VERIFY_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    throw new AppError(GENERIC_VERIFY_ERROR, 400);
  }

  // Guarded consume. bcrypt.compare takes ~100ms, which is a wide window for
  // two concurrent correct requests to both pass. Only one can flip the row,
  // so only one gets a session token.
  const consumed = await prisma.otpRequest.updateMany({
    where: { id: record.id, verified: false, expiresAt: { gt: new Date() } },
    data: { verified: true },
  });

  if (consumed.count === 0) {
    throw new AppError(GENERIC_VERIFY_ERROR, 400);
  }

  return { phone };
}

/**
 * Housekeeping. Call from a cron (daily is fine) — the table otherwise grows
 * forever and every findFirst/count above scans more rows.
 */
export async function purgeOldOtpRequests(olderThanHours = 24) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const { count } = await prisma.otpRequest.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

export const __testConfig = {
  OTP_EXPIRY_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  MIN_SECONDS_BETWEEN_REQUESTS,
  MAX_REQUESTS_PER_HOUR,
  MAX_REQUESTS_PER_DAY,
  MAX_DISTINCT_PHONES_PER_IP_HOUR,
  GENERIC_VERIFY_ERROR,
};
