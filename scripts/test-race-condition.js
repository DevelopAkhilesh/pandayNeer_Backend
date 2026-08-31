/**
 * Simulates two simultaneous verify-otp requests for the SAME new phone
 * number, to confirm the upsert fix prevents a P2002 crash.
 *
 * Usage:
 *   1. Call /api/auth/request-otp for TEST_PHONE first, check server logs for the OTP
 *   2. Set TEST_OTP below to that value
 *   3. Run: node scripts/test-race-condition.js
 */

const BASE_URL = 'http://localhost:5050';
const TEST_PHONE = '9625173250'; // use a phone number NOT already in your DB
const TEST_OTP = '531148'; // the OTP logged in your server console

async function verifyOnce(label) {
  const res = await fetch(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: TEST_PHONE, otp: TEST_OTP, name: 'Race Test' }),
  });
  const body = await res.json();
  console.log(`[${label}] status=${res.status}`, body);
}

async function main() {
  // Fire both requests at the exact same time, don't await sequentially
  await Promise.all([verifyOnce('Request A'), verifyOnce('Request B')]);
}

main();