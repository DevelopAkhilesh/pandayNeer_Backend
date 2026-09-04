import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock the SMS provider before importing the service under test.
vi.mock('../../services/sms/sms.provider.js', () => ({
  sendOtpSms: vi.fn(async () => ({ provider: 'mock', messageId: 'mock-1' })),
}));

import { prisma } from '../../config/db.js';
import { sendOtpSms } from '../../services/sms/sms.provider.js';
import {
  requestOtp,
  verifyOtp,
  purgeOldOtpRequests,
  __testConfig as CFG,
} from './otp.service.js';

const PHONE = '9876543210';
const OTHER_PHONE = '9123456789';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the plaintext OTP out of the mocked provider's last call. */
function lastSentOtp() {
  const calls = sendOtpSms.mock.calls;
  if (!calls.length) throw new Error('sendOtpSms was never called');
  return calls[calls.length - 1][1];
}

/** Request an OTP and return the plaintext code. */
async function requestAndGetCode(phone = PHONE) {
  await requestOtp(phone);
  return lastSentOtp();
}

/** Move a phone's rows back in time so cooldown/expiry windows are cleared. */
async function backdate(phone, seconds) {
  const shift = seconds * 1000;
  const rows = await prisma.otpRequest.findMany({ where: { phone } });
  await Promise.all(
    rows.map((r) =>
      prisma.otpRequest.update({
        where: { id: r.id },
        data: {
          createdAt: new Date(r.createdAt.getTime() - shift),
          expiresAt: new Date(r.expiresAt.getTime() - shift),
        },
      })
    )
  );
}

/** Force the newest OTP for a phone to be expired. */
async function expireNewest(phone) {
  const row = await prisma.otpRequest.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' },
  });
  await prisma.otpRequest.update({
    where: { id: row.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  return row;
}

/** Assert a call rejects with a given HTTP status (and optionally message). */
async function expectAppError(promise, status, messageMatch) {
  try {
    await promise;
  } catch (err) {
    expect(err.statusCode ?? err.status).toBe(status);
    if (messageMatch) expect(err.message).toMatch(messageMatch);
    return err;
  }
  throw new Error(
    `Expected rejection with status ${status}, but the call resolved successfully`
  );
}

beforeEach(async () => {
  await prisma.otpRequest.deleteMany({});
  // mockReset, not mockClear: mockClear only wipes recorded calls, leaving any
  // unconsumed mockRejectedValueOnce queued. If a test that queued one fails
  // or times out before triggering it, the rejection leaks into the next test
  // as a spurious 502.
  sendOtpSms.mockReset();
  sendOtpSms.mockImplementation(async () => ({
    provider: 'mock',
    messageId: 'mock-1',
  }));
});

afterAll(async () => {
  await prisma.otpRequest.deleteMany({});
  await prisma.$disconnect();
});


// ---------------------------------------------------------------------------
// 3. requestOtp — happy path
// ---------------------------------------------------------------------------

describe('requestOtp', () => {
  it('creates a row, hashes the code, and never stores plaintext', async () => {
    const code = await requestAndGetCode();
    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });

    expect(row).toBeTruthy();
    expect(row.otpHash).not.toBe(code);
    expect(row.otpHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.verified).toBe(false);
    expect(row.attempts).toBe(0);
  });

  it('sets expiry to the configured window', async () => {
    await requestOtp(PHONE);
    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    const minutes = (row.expiresAt - row.createdAt) / 60000;
    expect(minutes).toBeGreaterThan(CFG.OTP_EXPIRY_MINUTES - 0.5);
    expect(minutes).toBeLessThan(CFG.OTP_EXPIRY_MINUTES + 0.5);
  });

  it('normalizes before storing — +91 form and bare form share one record set', async () => {
    await requestOtp('+919876543210');
    const rows = await prisma.otpRequest.findMany({ where: { phone: PHONE } });
    expect(rows).toHaveLength(1);
  });

  it('rejects an invalid number with 400 and does not call the provider', async () => {
    await expectAppError(requestOtp('1234567890'), 400);
    expect(sendOtpSms).not.toHaveBeenCalled();
    expect(await prisma.otpRequest.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Cooldown and rate limits
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('blocks a second request inside the cooldown window', async () => {
    await requestOtp(PHONE);
    await expectAppError(requestOtp(PHONE), 429, /wait/i);
    expect(sendOtpSms).toHaveBeenCalledTimes(1);
  });

  it('allows a request once the cooldown has passed', async () => {
    await requestOtp(PHONE);
    await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    await expect(requestOtp(PHONE)).resolves.toBeTruthy();
    expect(sendOtpSms).toHaveBeenCalledTimes(2);
  });

  it('does NOT hold a user in cooldown after a successful verification', async () => {
    const code = await requestAndGetCode();
    await verifyOtp(PHONE, code);
    // Immediately request again — the previous request is verified, so the
    // cooldown must not apply to it.
    await expect(requestOtp(PHONE)).resolves.toBeTruthy();
  });

  it('enforces the hourly cap even when the cooldown is respected', async () => {
    for (let i = 0; i < CFG.MAX_REQUESTS_PER_HOUR; i++) {
      await requestOtp(PHONE);
      await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    }
    await expectAppError(requestOtp(PHONE), 429, /too many/i);
    expect(sendOtpSms).toHaveBeenCalledTimes(CFG.MAX_REQUESTS_PER_HOUR);
  });

  it('lets requests through again after the hour rolls over', async () => {
    for (let i = 0; i < CFG.MAX_REQUESTS_PER_HOUR; i++) {
      await requestOtp(PHONE);
      await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    }
    await backdate(PHONE, 3600 + 60);
    await expect(requestOtp(PHONE)).resolves.toBeTruthy();
  });

  it('enforces the daily cap', async () => {
    const now = Date.now();
    for (let i = 0; i < CFG.MAX_REQUESTS_PER_DAY; i++) {
      await prisma.otpRequest.create({
        data: {
          phone: PHONE,
          otpHash: '$2a$10$placeholderplaceholderplaceholderplaceholderpla',
          expiresAt: new Date(now - 1000),
          // 80 min apart: 15 rows span ~20h, and none fall inside the last hour,
          // so the hourly cap can't fire before the daily one.
          createdAt: new Date(now - (i + 1) * 80 * 60 * 1000),
        },
      });
    }
    await expectAppError(requestOtp(PHONE), 429, /daily/i);
  });

  it('rate limits are per-phone, not global', async () => {
    await requestOtp(PHONE);
    await expect(requestOtp(OTHER_PHONE)).resolves.toBeTruthy();
  });

  it('two simultaneous requests produce at most one delivered OTP', async () => {
    const results = await Promise.allSettled([
      requestOtp(PHONE),
      requestOtp(PHONE),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(sendOtpSms).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4b. Per-IP distinct-phone cap — the SMS-pumping control
// ---------------------------------------------------------------------------

describe('per-IP distinct phone cap', () => {
  const IP = '203.0.113.10';
  const OTHER_IP = '198.51.100.7';
  const PLACEHOLDER_HASH =
    '$2a$10$placeholderplaceholderplaceholderplaceholderpla';

  /**
   * Seed rows as if `count` distinct phones had already been sent to from one
   * IP. Inserted directly rather than via requestOtp — the cap is what is under
   * test, and 10 real requests would cost 10 bcrypt hashes and 10 transactions.
   */
  async function seedDistinctPhones(count, { ip = IP, minutesAgo = 1 } = {}) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      await prisma.otpRequest.create({
        data: {
          // Distinct from PHONE and from each other.
          phone: `9${String(200000000 + i)}`,
          otpHash: PLACEHOLDER_HASH,
          ip,
          expiresAt: new Date(now - 1000),
          createdAt: new Date(now - minutesAgo * 60 * 1000),
        },
      });
    }
  }

  it('blocks a new phone once the IP is at the cap', async () => {
    await seedDistinctPhones(CFG.MAX_DISTINCT_PHONES_PER_IP_HOUR);
    await expectAppError(requestOtp(PHONE, { ip: IP }), 429, /too many/i);
    expect(sendOtpSms).not.toHaveBeenCalled();
  });

  it('allows a new phone while the IP is one below the cap', async () => {
    await seedDistinctPhones(CFG.MAX_DISTINCT_PHONES_PER_IP_HOUR - 1);
    await expect(requestOtp(PHONE, { ip: IP })).resolves.toBeTruthy();
  });

  it('does not count the requesting phone against itself', async () => {
    // One short of the cap in OTHER phones, plus a row for PHONE itself. If the
    // cap counted the caller's own number the total would trip it — a real user
    // re-requesting their own code must never be blocked by this control.
    await seedDistinctPhones(CFG.MAX_DISTINCT_PHONES_PER_IP_HOUR - 1);
    await prisma.otpRequest.create({
      data: {
        phone: PHONE,
        otpHash: PLACEHOLDER_HASH,
        ip: IP,
        expiresAt: new Date(Date.now() - 1000),
        // Outside the 60s cooldown, inside the hour.
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    await expect(requestOtp(PHONE, { ip: IP })).resolves.toBeTruthy();
  });

  it('buckets per IP — a different address is unaffected', async () => {
    await seedDistinctPhones(CFG.MAX_DISTINCT_PHONES_PER_IP_HOUR);
    await expect(requestOtp(PHONE, { ip: OTHER_IP })).resolves.toBeTruthy();
  });

  it('only counts the last hour', async () => {
    await seedDistinctPhones(CFG.MAX_DISTINCT_PHONES_PER_IP_HOUR, {
      minutesAgo: 90,
    });
    await expect(requestOtp(PHONE, { ip: IP })).resolves.toBeTruthy();
  });

  it('skips the check when no IP is supplied', async () => {
    // `ip = NULL` matches nothing in SQL, so rows with a null ip must not
    // aggregate into one shared bucket that locks every caller out.
    await seedDistinctPhones(CFG.MAX_DISTINCT_PHONES_PER_IP_HOUR, { ip: null });
    await expect(requestOtp(PHONE)).resolves.toBeTruthy();
  });

  it('stores the ip on the row it creates', async () => {
    await requestOtp(PHONE, { ip: IP });
    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    expect(row.ip).toBe(IP);
  });

  it('stores null when no ip is given', async () => {
    await requestOtp(PHONE);
    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    expect(row.ip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Re-request invalidation
// ---------------------------------------------------------------------------

describe('re-requesting an OTP', () => {
  it('invalidates the previous code — only the newest one works', async () => {
    const first = await requestAndGetCode();
    await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    const second = await requestAndGetCode();

    expect(first).not.toBe(second);
    await expectAppError(verifyOtp(PHONE, first), 400);
    await expect(verifyOtp(PHONE, second)).resolves.toBeTruthy();
  });

  it('does not mark superseded OTPs as verified (analytics integrity)', async () => {
    await requestOtp(PHONE);
    await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    await requestOtp(PHONE);

    const verifiedCount = await prisma.otpRequest.count({
      where: { phone: PHONE, verified: true },
    });
    expect(verifiedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. SMS send failure
// ---------------------------------------------------------------------------

describe('SMS delivery failure', () => {
  it('surfaces a 502 instead of reporting success', async () => {
    sendOtpSms.mockRejectedValueOnce(new Error('MSG91 down'));
    await expectAppError(requestOtp(PHONE), 502, /could not send/i);
  });

  it('does not strand the user in cooldown after a failed send', async () => {
  sendOtpSms.mockRejectedValueOnce(new Error('MSG91 down'));
  await expectAppError(requestOtp(PHONE), 502);
  // No backdate. If the failed row still blocks, this throws 429.
  await expect(requestOtp(PHONE)).resolves.toBeTruthy();
});

it('failed sends do not consume the hourly cap', async () => {
  // Persistent, not Once: a one-shot queued per iteration is only consumed if
  // that iteration actually reaches the send, so any early throw leaves the
  // queue out of step with the loop.
  sendOtpSms.mockRejectedValue(new Error('MSG91 down'));

  for (let i = 0; i < CFG.MAX_REQUESTS_PER_HOUR + 2; i++) {
    await expectAppError(requestOtp(PHONE), 502);
  }

  // Restore success so the final request can actually go through.
  sendOtpSms.mockResolvedValue({ provider: 'mock', messageId: 'mock-1' });
  await expect(requestOtp(PHONE)).resolves.toBeTruthy();
});

it('a failed code cannot be used even though the row remains', async () => {
  sendOtpSms.mockRejectedValueOnce(new Error('MSG91 down'));
  await expectAppError(requestOtp(PHONE), 502);
  await expectAppError(verifyOtp(PHONE, lastSentOtp()), 400);
});
});

// ---------------------------------------------------------------------------
// 7. verifyOtp
// ---------------------------------------------------------------------------

describe('verifyOtp', () => {
  it('accepts the correct code and marks it verified', async () => {
    const code = await requestAndGetCode();
    await expect(verifyOtp(PHONE, code)).resolves.toEqual({ phone: PHONE });

    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    expect(row.verified).toBe(true);
  });

  it('accepts the code when the phone is sent in a different format', async () => {
    const code = await requestAndGetCode(PHONE);
    await expect(verifyOtp('+91 98765 43210', code)).resolves.toBeTruthy();
  });

  it('rejects a wrong code and increments attempts', async () => {
    const code = await requestAndGetCode();
    const wrong = code === '123456' ? '654321' : '123456';

    await expectAppError(verifyOtp(PHONE, wrong), 400);
    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    expect(row.attempts).toBe(1);
    expect(row.verified).toBe(false);
  });

  it('rejects an expired code', async () => {
    const code = await requestAndGetCode();
    await expireNewest(PHONE);
    await expectAppError(verifyOtp(PHONE, code), 400);
  });

  it('rejects a code for a phone that never requested one', async () => {
    await expectAppError(verifyOtp(OTHER_PHONE, '123456'), 400);
  });

  it("rejects another phone's code", async () => {
    const code = await requestAndGetCode(PHONE);
    await expectAppError(verifyOtp(OTHER_PHONE, code), 400);
  });

  it.each([
    ['12345', 'five digits'],
    ['1234567', 'seven digits'],
    ['12a456', 'contains a letter'],
    ['', 'empty'],
    ['      ', 'whitespace only'],
    [null, 'null'],
    [undefined, 'undefined'],
    [123456, 'number type'],
    ['1'.repeat(5000), 'huge payload — must not reach bcrypt'],
  ])(
    'rejects malformed code %s (%s) without touching the row',
    async (badCode) => {
      await requestAndGetCode();
      await expectAppError(verifyOtp(PHONE, badCode), 400);
      const row = await prisma.otpRequest.findFirst({
        where: { phone: PHONE },
      });
      expect(row.attempts).toBe(0);
    }
  );

  it('tolerates surrounding whitespace in an otherwise valid code', async () => {
    const code = await requestAndGetCode();
    await expect(verifyOtp(PHONE, `  ${code}  `)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 8. Attempt exhaustion
// ---------------------------------------------------------------------------

describe('attempt limit', () => {
  it('locks the code after the max number of wrong guesses', async () => {
    const code = await requestAndGetCode();
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 0; i < CFG.MAX_VERIFY_ATTEMPTS; i++) {
      await expectAppError(verifyOtp(PHONE, wrong), 400);
    }

    // Even the CORRECT code must now fail.
    await expectAppError(verifyOtp(PHONE, code), 400);

    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    expect(row.attempts).toBe(CFG.MAX_VERIFY_ATTEMPTS);
    expect(row.verified).toBe(false);
  });

  it('never lets attempts exceed the max under concurrent wrong guesses', async () => {
    await requestAndGetCode();
    const wrong = '000000';
    await Promise.allSettled(
      Array.from({ length: 20 }, () => verifyOtp(PHONE, wrong))
    );
    const row = await prisma.otpRequest.findFirst({ where: { phone: PHONE } });
    expect(row.attempts).toBeLessThanOrEqual(CFG.MAX_VERIFY_ATTEMPTS);
  });

  it('a fresh OTP resets the attempt counter', async () => {
    const code = await requestAndGetCode();
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < CFG.MAX_VERIFY_ATTEMPTS; i++) {
      await expectAppError(verifyOtp(PHONE, wrong), 400);
    }

    await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    const fresh = await requestAndGetCode();
    await expect(verifyOtp(PHONE, fresh)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 9. Replay and the double-consume race
// ---------------------------------------------------------------------------

describe('single use', () => {
  it('rejects reuse of a code that already verified', async () => {
    const code = await requestAndGetCode();
    await verifyOtp(PHONE, code);
    await expectAppError(verifyOtp(PHONE, code), 400);
  });

  it('two concurrent correct verifications produce exactly one success', async () => {
    const code = await requestAndGetCode();
    const results = await Promise.allSettled([
      verifyOtp(PHONE, code),
      verifyOtp(PHONE, code),
      verifyOtp(PHONE, code),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Error message uniformity (no state leak)
// ---------------------------------------------------------------------------

describe('error messages do not leak state', () => {
  it('returns an identical message for wrong / expired / unknown / consumed', async () => {
    const messages = new Set();

    // wrong code
    const code = await requestAndGetCode();
    messages.add(
      (await expectAppError(verifyOtp(PHONE, '000000'), 400)).message
    );

    // consumed
    await verifyOtp(PHONE, code);
    messages.add((await expectAppError(verifyOtp(PHONE, code), 400)).message);

    // unknown phone
    messages.add(
      (await expectAppError(verifyOtp(OTHER_PHONE, '123456'), 400)).message
    );

    // expired
    await backdate(PHONE, CFG.MIN_SECONDS_BETWEEN_REQUESTS + 5);
    const c2 = await requestAndGetCode();
    await expireNewest(PHONE);
    messages.add((await expectAppError(verifyOtp(PHONE, c2), 400)).message);

    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe(CFG.GENERIC_VERIFY_ERROR);
  });
});

// ---------------------------------------------------------------------------
// 10b. Timing uniformity — the same leak through a different channel
// ---------------------------------------------------------------------------

describe('timing does not leak state', () => {
  it('takes similar time for a wrong code and for no pending OTP', async () => {
    await requestAndGetCode(PHONE);

    const t1 = Date.now();
    await expect(verifyOtp(PHONE, '000000')).rejects.toThrow();
    const wrongCode = Date.now() - t1;

    const t2 = Date.now();
    await expect(verifyOtp(OTHER_PHONE, '000000')).rejects.toThrow();
    const noPending = Date.now() - t2;

    // Generous bound — this catches the ~100ms gap the dummy hash closes,
    // without failing on ordinary scheduling jitter.
    expect(Math.abs(wrongCode - noPending)).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// 11. Housekeeping
// ---------------------------------------------------------------------------

describe('purgeOldOtpRequests', () => {
  it('removes rows past the cutoff and keeps recent ones', async () => {
    await requestOtp(PHONE);
    await prisma.otpRequest.create({
      data: {
        phone: OTHER_PHONE,
        otpHash: '$2a$10$placeholderplaceholderplaceholderplaceholderpla',
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    });

    const removed = await purgeOldOtpRequests(24);
    expect(removed).toBe(1);
    expect(await prisma.otpRequest.count()).toBe(1);
  });
});
