import { prisma } from '../../config/db.js';

/**
 * In-process cache of the pincodes we currently deliver to.
 *
 * ServiceArea is a handful of rows that change maybe twice a month, and the
 * public /check endpoint is the app's first screen. Querying Postgres on every
 * page load adds ~66ms to that screen to re-learn something that has not
 * changed since last month.
 *
 * Deliberately a plain Map rather than Redis. The whole set is a few dozen
 * six-character strings — under a kilobyte — so a hash lookup in this process
 * beats a network round trip to a cache server. Redis would only earn its
 * place if this data were too large for memory or had to be shared.
 *
 * The cost of that choice: each instance holds its own copy, so after an admin
 * toggles an area, other instances stay wrong for up to TTL_MS. That is
 * survivable ONLY because /check is not the last word — address creation and
 * order placement re-check against the database directly. A stale cache can
 * let someone past the first screen; it cannot let an order through for an
 * area we do not cover. Do not use this cache at those later gates.
 */

const TTL_MS = 60_000;

// Map<pincode, areaName | null>. Presence means serviceable — inactive rows are
// never loaded, so `has()` is the entire check. areaName is nullable in the
// schema, which is why this is a Map and not a Set.
let entries = null;
let expiresAt = 0;

// The in-flight refresh, shared by every caller that arrives while it runs.
// Without this, a TTL lapse under load fires one query per concurrent request
// instead of one query total — the cache stampede.
let refreshing = null;

async function load() {
  const rows = await prisma.serviceArea.findMany({
    where: { isActive: true },
    select: { pincode: true, areaName: true },
  });

  entries = new Map(rows.map((row) => [row.pincode, row.areaName]));
  expiresAt = Date.now() + TTL_MS;
  console.log(
    `[cache] loaded ${entries.size} active areas at ${new Date().toISOString()}`
  );
  return entries;
}

function refresh() {
  // ??= is what makes this a stampede guard: the first caller starts the query
  // and every caller behind it awaits the same promise.
  refreshing ??= load().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * The current serviceable set, refreshing it if the TTL has lapsed.
 *
 * If the refresh fails but we still hold an old copy, the old copy is served.
 * A pincode list that is sixty seconds out of date is a far better answer than
 * a 500 on the app's opening screen, and the later gates catch anything this
 * gets wrong.
 */
export async function getServiceableAreas() {
  if (entries && Date.now() < expiresAt) return entries;

  try {
    return await refresh();
  } catch (err) {
    if (entries) {
      console.error(
        'ServiceArea cache refresh failed, serving stale data:',
        err.message
      );
      return entries;
    }
    // Nothing cached and the database is unreachable. Nothing useful to say.
    throw err;
  }
}

/**
 * Looks up one pincode.
 *
 * Returns `{ areaName }` when serviceable, or null. Null covers both "paused"
 * and "never added" — the caller cannot tell them apart, which is intentional
 * for the public endpoint.
 */
export async function lookupServiceableArea(pincode) {
  const areas = await getServiceableAreas();
  return areas.has(pincode) ? { areaName: areas.get(pincode) } : null;
}

/**
 * Marks the cache stale so the next read reloads it.
 *
 * Called by the admin write routes. Expiring rather than clearing keeps the old
 * copy around as a fallback if the reload then fails.
 *
 * This only fixes THIS instance. Other instances catch up on their own TTL.
 * When that gap stops being acceptable, this is the function a Redis pub/sub
 * broadcast would hook into — the callers do not change.
 */
export function invalidateServiceAreaCache() {
  expiresAt = 0;
}

/**
 * Fills the cache at boot so the first customer of the day does not pay for it.
 * Safe to fail — the first request will just load it normally.
 */
export function primeServiceAreaCache() {
  return refresh();
}
