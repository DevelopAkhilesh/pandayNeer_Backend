import { Router } from 'express';
import rateLimit, { ipKeyGenerator, MINUTE, HOUR } from 'express-rate-limit';
import {
  logoutAllHandler,
  meHandler,
  requestOtpHandler,
  updateMeHandler,
  verifyOtpHandler,
} from './auth.controller.js';
import { requireAuth } from '../../middleware/authGuard.js';

const router = Router();

// ---------------------------------------------------------------------------
// IMPORTANT: this file assumes `app.set('trust proxy', 1)` is set in app.js.
// Without it, behind Render/Railway/nginx every request reports the proxy's IP,
// so all your users share a single rate-limit bucket and the first five people
// to log in lock out everyone else for 15 minutes.
// ---------------------------------------------------------------------------

/**
 * Coarse IP limit on OTP requests.
 *
 * 5 per 15 min is too tight for India. Jio and Airtel put large numbers of
 * mobile users behind carrier-grade NAT, so hundreds of unrelated customers can
 * share one public IP. At 5/15min those users would randomly fail to log in
 * with no way to tell why.
 *
 * 30/15min is loose enough not to hurt shared IPs and still caps the crude
 * flooding case. The real fraud control is the distinct-phone guard below.
 */
const otpRequestIpLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests. Please try again in a few minutes.',
  },
});

/**
 * Verification attempts. Looser still — a shared IP means many people typing
 * codes at once, and the real control is the 5-attempt cap per OTP.
 *
 * skipSuccessfulRequests means only failures count, so a busy office or an
 * apartment block on one connection is never penalised for logging in normally.
 */
const otpVerifyIpLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  max: 50,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again in a few minutes.',
  },
});

/**
 * The actual SMS-pumping defence: cap how many DISTINCT phone numbers one IP
 * can trigger sends to per hour.
 *
 * A plain request counter does not stop this attack. The attacker rotates
 * numbers, so each number stays under the per-phone cooldown and daily cap
 * while your SMS bill climbs at roughly a rupee per four messages. Normal users
 * request OTPs for one number, occasionally two or three (family sharing a
 * phone, a mistyped number). Ten in an hour from one IP is not a real customer.
 *
 * Enforced inside requestOtp's transaction against the OtpRequest table — see
 * MAX_DISTINCT_PHONES_PER_IP_HOUR there. This limiter is just the outer net.
 */
const otpDistinctPhoneIpLimiter = rateLimit({
  windowMs: 1 * HOUR,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  // Bucket per IP. ipKeyGenerator handles IPv6 correctly — a raw req.ip key
  // lets an attacker with an IPv6 /64 rotate addresses and get a fresh bucket
  // for each one.
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    message: 'Too many OTP requests. Please try again later.',
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// request otp
router.post(
  '/request-otp',
  otpRequestIpLimiter,
  otpDistinctPhoneIpLimiter,
  requestOtpHandler
);
// verify the otp
router.post('/verify-otp', otpVerifyIpLimiter, verifyOtpHandler);
// getting the user info
router.get('/me', requireAuth, meHandler);
// setting the name on the screen shown right after login
router.patch('/me', requireAuth, updateMeHandler);
// logout from all devices
router.post('/logout-all', requireAuth, logoutAllHandler);

export default router;
