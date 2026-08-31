import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requestOtpHandler, verifyOtpHandler } from './auth.controller.js';

const router = Router();

// ---------- Rate Limiters (IP-based) ----------

/**
 * Limits OTP requests to 5 per 15 min per IP.
 * Prevents mass SMS bombing across many phone numbers.
 * Works alongside the 60s per‑phone cooldown in the service layer.
 */
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests from this device. Please try again later.',
  },
});

/**
 * Limits verification attempts to 20 per 15 min per IP.
 * Looser than request limiter to allow for typos.
 * Real security is in the 5‑attempt per OTP and expiry, so this is just a coarse net.
 */
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts from this device. Please try again later.',
  },
});

// ---------- Routes ----------

// Initiate OTP flow – applies IP rate limit + per‑phone cooldown (service)
router.post('/request-otp', otpRequestLimiter, requestOtpHandler);

// Verify OTP and login/register – applies IP rate limit + per‑OTP attempt cap (service)
router.post('/verify-otp', otpVerifyLimiter, verifyOtpHandler);

export default router;