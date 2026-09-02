import axios from 'axios';
import { env } from '../../config/env.js';

const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow';
const SEND_TIMEOUT_MS = 10_000;

// All three are required together. Two of three is never a working config.
const MSG91_KEYS = ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_TEMPLATE_ID'];

/**
 * Console transport — the mode this runs in until DLT registration completes.
 *
 * Prints the code instead of sending it, so the whole login flow stays testable
 * with no provider account. resolveProvider() below refuses to select this in
 * production, which is what keeps it from silently shipping.
 */
async function sendViaConsole(phone, otp) {
  // Suppressed under test only to keep the suite output readable.
  if (env.NODE_ENV !== 'test') {
    console.log(`[sms:console] OTP for ${phone} is ${otp}`);
  }
  return { provider: 'console', messageId: null };
}

/**
 * MSG91 transport. Selected automatically once the three keys are present.
 *
 * MUST throw on failure. If this swallows errors, requestOtp reports
 * "OTP sent successfully" for a code that never left the building.
 */
async function sendViaMsg91(phone, otp) {
  let res;
  try {
    res = await axios.post(
      MSG91_FLOW_URL,
      {
        template_id: env.MSG91_TEMPLATE_ID,
        sender: env.MSG91_SENDER_ID,
        short_url: '0',
        // `OTP` must match the variable name in the MSG91 Flow exactly,
        // including case. A mismatch is the most common reason a correctly
        // registered template returns success and delivers an empty message.
        recipients: [{ mobiles: `91${phone}`, OTP: otp }],
      },
      {
        headers: {
          authkey: env.MSG91_AUTH_KEY,
          'Content-Type': 'application/json',
        },
        timeout: SEND_TIMEOUT_MS,
      }
    );
  } catch (err) {
    // axios reports "Request failed with status code 401", which says nothing
    // about why. MSG91 puts the real reason in the response body.
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    // `cause` keeps the original axios error — status, headers, request config
    // — reachable for debugging while the message stays readable.
    throw new Error(`MSG91 request failed: ${detail}`, { cause: err });
  }

  // Require an explicit success. Testing `type !== 'success'` only when `type`
  // exists would treat an empty body or an HTML error page as a sent message.
  if (res.data?.type !== 'success') {
    throw new Error(
      `MSG91 rejected the send: ${res.data?.message ?? JSON.stringify(res.data)}`
    );
  }

  return { provider: 'msg91', messageId: res.data?.request_id ?? null };
}

/**
 * Picks the transport from configuration alone, once, at startup.
 *
 * Adding the three MSG91 keys to .env is the entire switch from console mode to
 * live SMS — there is no code path to change and no flag to flip. Resolving
 * here rather than per request means a broken config fails at boot instead of
 * at the first real user's login.
 */
function resolveProvider() {
  const present = MSG91_KEYS.filter((key) => env[key]);

  if (present.length > 0 && present.length < MSG91_KEYS.length) {
    const missing = MSG91_KEYS.filter((key) => !env[key]);
    throw new Error(
      `SMS configuration is incomplete: ${present.join(', ')} set, but ` +
        `${missing.join(', ')} missing. Set all three to send via MSG91, or ` +
        `leave all three blank to stay in console mode.`
    );
  }

  if (present.length === MSG91_KEYS.length) {
    return { name: 'msg91', send: sendViaMsg91 };
  }

  // No credentials. Correct while DLT registration is pending — never correct
  // in production, where it would report success for undelivered codes.
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'No SMS provider is configured and NODE_ENV is production. Set ' +
        `${MSG91_KEYS.join(', ')} before deploying.`
    );
  }

  return { name: 'console', send: sendViaConsole };
}

const provider = resolveProvider();

/** Which transport is active. Logged at startup so the mode is never a guess. */
export const smsProviderName = provider.name;

export async function sendOtpSms(phone, otp) {
  return provider.send(phone, otp);
}
