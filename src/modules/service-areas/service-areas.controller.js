import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  lookupServiceableArea,
  invalidateServiceAreaCache,
} from './service-areas.cache.js';

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Public serviceability check. No auth — this is the first screen of the app,
 * shown before anyone has a phone number to log in with.
 *
 * Reads the in-process cache rather than the database. See the notes in
 * service-areas.cache.js for why that is safe here and nowhere else.
 *
 * Returns 200 with `serviceable: false` rather than a 404. "We do not deliver
 * to Thane" is a successful answer to a valid question; a 404 would say the
 * route does not exist and push the client into its generic error path, which
 * is the wrong screen entirely.
 */
export async function checkServiceabilityHandler(req, res) {
  const { pincode } = req.valid.query;

  // Null for both a paused area and one that was never added. The distinction
  // ("we usually cover this but not today") is admin information and belongs
  // in the admin list below, not on a public endpoint.
  const area = await lookupServiceableArea(pincode);

  res.status(200).json({
    success: true,
    data: {
      pincode,
      serviceable: Boolean(area),
      // Null when unserviceable, so the client never renders a place name for
      // an area it cannot order from.
      areaName: area?.areaName ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * Full list, inactive rows included — an admin who cannot see a paused area
 * cannot un-pause it.
 *
 * Reads the database directly, never the cache. The cache only holds active
 * rows, which is precisely the half this endpoint exists to show.
 */
export async function listServiceAreasHandler(req, res) {
  const { isActive, search } = req.valid.query;

  const areas = await prisma.serviceArea.findMany({
    where: {
      ...(isActive === undefined ? {} : { isActive }),
      ...(search ? { pincode: { startsWith: search } } : {}),
    },
    orderBy: { pincode: 'asc' },
    select: {
      id: true,
      pincode: true,
      areaName: true,
      isActive: true,
      createdAt: true,
      // The count, not the rows. An admin scanning the list needs to know an
      // area has nobody covering it; the names belong on the detail page.
      _count: { select: { deliveryBoys: true } },
    },
  });

  res.status(200).json({ success: true, data: areas });
}

/**
 * One area with the delivery boys attached to it.
 *
 * This is the screen to check before deactivating anything — it answers "who
 * covers Andheri West, and who am I about to leave with no area?"
 */
export async function getServiceAreaHandler(req, res) {
  const { id } = req.valid.params;

  const area = await prisma.serviceArea.findUnique({
    where: { id },
    select: {
      id: true,
      pincode: true,
      areaName: true,
      isActive: true,
      createdAt: true,
      deliveryBoys: {
        select: {
          id: true,
          vehicleNumber: true,
          isAvailable: true,
          // Name and phone only. This is an admin screen, but there is still
          // no reason to ship tokenVersion or account status here.
          user: { select: { id: true, name: true, phone: true } },
        },
      },
    },
  });

  if (!area) {
    throw new AppError('Service area not found', 404);
  }

  res.status(200).json({ success: true, data: area });
}

/**
 * Adds a pincode to the coverage list.
 *
 * A duplicate pincode surfaces as Prisma's P2002 — no pre-check with
 * findUnique. That check would be a race anyway: two admins submitting at once
 * both see "free" and one still fails on the unique index. Let the database be
 * the one that decides.
 */
export async function createServiceAreaHandler(req, res) {
  const { pincode, areaName } = req.valid.body;

  let area;
  try {
    area = await prisma.serviceArea.create({
      data: { pincode, areaName: areaName ?? null },
      select: {
        id: true,
        pincode: true,
        areaName: true,
        isActive: true,
        createdAt: true,
      },
    });
  } catch (err) {
    // errorHandler maps P2002 to a bare "already exists", which sends an admin
    // hunting for a row that is not in the default view. Deactivated areas keep
    // their pincode and so still collide — that is the likely cause here, and
    // the fix is to reactivate rather than re-add.
    if (err.code === 'P2002') {
      throw new AppError(
        'This pincode is already in the list. It may be deactivated — find it with ?isActive=false and reactivate it instead of adding it again.',
        409
      );
    }
    throw err;
  }

  // New rows default to isActive: true, so this one is immediately live and the
  // cached list is now wrong.
  invalidateServiceAreaCache();

  res.status(201).json({ success: true, data: area });
}

/**
 * Renames an area or toggles it on and off.
 *
 * Pausing rather than deleting is the whole reason isActive exists — see the
 * note on the delete handler below.
 */
export async function updateServiceAreaHandler(req, res) {
  const { id } = req.valid.params;
  const data = req.valid.body;

  // P2025 when the id does not exist, which errorHandler turns into a 404.
  const area = await prisma.serviceArea.update({
    where: { id },
    data,
    select: {
      id: true,
      pincode: true,
      areaName: true,
      isActive: true,
      createdAt: true,
    },
  });

  // Invalidate on any update, not just an isActive change: areaName is served
  // from the cache too, so a rename would otherwise show the old label for up
  // to a minute.
  invalidateServiceAreaCache();

  res.status(200).json({ success: true, data: area });
}

/**
 * DELETE deactivates. It does not delete.
 *
 * DeliveryBoyProfile.assignedServiceAreaId is onDelete: SetNull, so a real
 * delete would silently unassign every delivery boy in the area — no error, no
 * warning. You find out days later when nobody is picking up orders there.
 *
 * The route is still DELETE because that is what the admin UI's delete button
 * will call, and the customer-visible effect is identical. The row survives,
 * with its assignments intact, ready to be switched back on.
 */
export async function deactivateServiceAreaHandler(req, res) {
  const { id } = req.valid.params;

  const area = await prisma.serviceArea.update({
    where: { id },
    data: { isActive: false },
    select: {
      id: true,
      pincode: true,
      areaName: true,
      isActive: true,
      createdAt: true,
    },
  });

  invalidateServiceAreaCache();

  res.status(200).json({
    success: true,
    message: 'Service area deactivated',
    data: area,
  });
}
