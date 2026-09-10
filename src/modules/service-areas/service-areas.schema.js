import { z } from 'zod';

/**
 * Indian pincodes are exactly six digits and never start with zero — the first
 * digit is the postal region, and there is no region 0.
 *
 * Kept as a string rather than coerced to a number on purpose. Nothing here
 * does arithmetic on a pincode, and z.coerce.number() would happily accept
 * "0400053" and " 400053 " as the same value while silently dropping the
 * leading-zero rule this regex exists to enforce.
 */
export const PINCODE_REGEX = /^[1-9][0-9]{5}$/;

const pincode = z
  .string({ message: 'Pincode is required' })
  .trim()
  .regex(PINCODE_REGEX, 'Enter a valid 6-digit pincode');

// areaName is nullable in the schema — an area can exist without a label. But
// an empty string is not the same as "no label", so it is rejected rather than
// quietly stored.
const areaName = z
  .string()
  .trim()
  .min(1, 'Area name cannot be empty')
  .max(100, 'Area name is too long');

// Every write route takes the row id in the path. uuid() rather than a bare
// string so a malformed id returns 400 here instead of reaching Prisma and
// coming back as a confusing 500.
const idParams = z.object({
  id: z.uuid('Invalid service area id'),
});

/**
 * GET /api/service-areas/check?pincode=400053  (public)
 *
 * Query rather than a path param because this is a lookup, not a resource. The
 * caller is asking a question about a pincode, not fetching the row for one —
 * and the row is not theirs to fetch, since this endpoint is unauthenticated.
 */
export const checkServiceabilitySchema = {
  query: z.object({ pincode }),
};

/**
 * GET /api/service-areas  (admin)
 *
 * Both filters optional. Query strings arrive as strings, so isActive is parsed
 * from the two literals rather than z.coerce.boolean() — which treats every
 * non-empty string as true and would make ?isActive=false mean "active".
 */
export const listServiceAreasSchema = {
  query: z.object({
    isActive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    // Partial pincode match, for the admin search box.
    search: z.string().trim().max(6).optional(),
  }),
};

/** GET /api/service-areas/:id  (admin) */
export const getServiceAreaSchema = { params: idParams };

/** POST /api/service-areas  (admin) */
export const createServiceAreaSchema = {
  body: z.object({
    pincode,
    areaName: areaName.optional(),
  }),
};

/**
 * PATCH /api/service-areas/:id  (admin)
 *
 * pincode is deliberately not editable. Changing it would silently move every
 * delivery boy assigned to this row to a different real-world area. Deactivate
 * the wrong one and create the right one instead.
 *
 * areaName accepts null so a label can be cleared. The refine is what stops an
 * empty body from being a successful no-op that looks like a saved change in
 * the admin UI.
 */
export const updateServiceAreaSchema = {
  params: idParams,
  // strictObject, not object, and the only place in this file that differs.
  // Elsewhere stripping unknown keys is the safe default — it stops a client
  // slipping an extra column into a Prisma write. On a PATCH it hides typos
  // instead: `{"isActiv": true}` would be stripped to `{}` and answered with
  // "provide at least one field", which reads like the request never arrived.
  body: z
    .strictObject({
      areaName: areaName.nullable().optional(),
      isActive: z.boolean().optional(),
      // Named explicitly so sending it gets a real explanation rather than
      // "unrecognized key". It is the one field an admin will reasonably
      // expect to edit, and the answer is a workflow, not a rejection.
      pincode: z
        .never({
          error:
            'Pincode cannot be changed. Deactivate this area and create the correct one.',
        })
        .optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'Provide at least one field to update',
    }),
};

/** DELETE /api/service-areas/:id  (admin) — deactivates, see the controller. */
export const deactivateServiceAreaSchema = { params: idParams };
