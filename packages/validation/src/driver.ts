import { z } from 'zod';
import { canadianProvinceSchema, latLngSchema } from './common';
import { rideClassSchema } from './ride';

/**
 * Driver domain input validation (Phase 2).
 *
 * Every schema here is the single source of truth for a request body: the Nest
 * controllers run them through ZodValidationPipe and the driver app / dashboard
 * import the inferred types, so the two can never drift.
 */

// ---------------------------------------------------------------------------
// Profile / application
// ---------------------------------------------------------------------------

/**
 * Licence formats vary widely by province, so we validate shape loosely and
 * leave authenticity to the human KYC review rather than rejecting a valid
 * licence with an over-specific regex.
 */
export const licenceNumberSchema = z
  .string()
  .trim()
  .min(4)
  .max(32)
  .regex(/^[A-Za-z0-9-]+$/, 'Licence number may contain letters, digits and dashes only');

export const driverApplySchema = z.object({
  licenceNumber: licenceNumberSchema,
  licenceProvince: canadianProvinceSchema,
  /** Must be in the future — an expired licence cannot start an application. */
  licenceExpiresAt: z.string().datetime({ offset: true }),
});
export type DriverApplyInput = z.infer<typeof driverApplySchema>;

export const driverProfileUpdateSchema = driverApplySchema.partial();
export type DriverProfileUpdateInput = z.infer<typeof driverProfileUpdateSchema>;

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------

/** Plates are normalised to upper-case with all whitespace and dashes removed. */
export const plateSchema = z
  .string()
  .trim()
  .min(2)
  .max(12)
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^[A-Z0-9]+$/, 'Plate may contain letters and digits only'));

const CURRENT_YEAR = 2026;

export const vehicleCreateSchema = z.object({
  make: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(64),
  /**
   * Upper bound allows next-model-year vehicles, which go on sale before the
   * calendar year rolls over. Lower bound is a fleet-age policy, not a data
   * constraint — most jurisdictions cap rideshare vehicle age near 15 years.
   */
  year: z.coerce
    .number()
    .int()
    .min(CURRENT_YEAR - 15)
    .max(CURRENT_YEAR + 1),
  color: z.string().trim().min(1).max(32),
  plate: plateSchema,
  province: canadianProvinceSchema,
  rideClass: rideClassSchema.default('standard'),
  seats: z.coerce.number().int().min(1).max(8).default(4),
});
export type VehicleCreateInput = z.infer<typeof vehicleCreateSchema>;

export const vehicleUpdateSchema = vehicleCreateSchema.partial();
export type VehicleUpdateInput = z.infer<typeof vehicleUpdateSchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const driverDocumentTypeSchema = z.enum([
  'drivers_license_front',
  'drivers_license_back',
  'vehicle_registration',
  'insurance',
  'profile_photo',
  'background_check',
]);
export type DriverDocumentTypeInput = z.infer<typeof driverDocumentTypeSchema>;

/** Accepted upload formats. Kept narrow — these are reviewed by a human. */
export const DRIVER_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** 10 MB — comfortably fits a phone photo without inviting abuse. */
export const DRIVER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export const documentUploadMetaSchema = z.object({
  type: driverDocumentTypeSchema,
  /** Required for licence / insurance / registration; ignored for photos. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type DocumentUploadMetaInput = z.infer<typeof documentUploadMetaSchema>;

// ---------------------------------------------------------------------------
// Availability / location
// ---------------------------------------------------------------------------

export const goOnlineSchema = z.object({
  /** Omit to use the active vehicle on the driver profile. */
  vehicleId: z.string().uuid().optional(),
  /** Position at the moment of going online, so dispatch can see them at once. */
  location: latLngSchema,
});
export type GoOnlineInput = z.infer<typeof goOnlineSchema>;

export const locationPingSchema = z.object({
  location: latLngSchema,
  headingDegrees: z.coerce.number().min(0).max(360).optional(),
  speedMps: z.coerce.number().min(0).max(90).optional(),
  accuracyMeters: z.coerce.number().min(0).max(10_000).optional(),
  /**
   * Client-side capture time. Lets the server discard pings that queued up
   * while the device was offline instead of treating stale points as current.
   */
  recordedAt: z.string().datetime({ offset: true }).optional(),
});
export type LocationPingInput = z.infer<typeof locationPingSchema>;

/** Batched pings flushed after a connectivity gap. Ordered oldest-first. */
export const locationPingBatchSchema = z.object({
  pings: z.array(locationPingSchema).min(1).max(100),
});
export type LocationPingBatchInput = z.infer<typeof locationPingBatchSchema>;

// ---------------------------------------------------------------------------
// Geo search
// ---------------------------------------------------------------------------

export const nearbyDriversQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  /** Search radius. Capped at 25 km — beyond that the ETA is never acceptable. */
  radiusMeters: z.coerce.number().int().min(100).max(25_000).default(5_000),
  rideClass: rideClassSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  /**
   * Pings older than this are treated as stale and excluded — a driver whose
   * app was killed must not keep receiving offers at their last known corner.
   */
  maxAgeSeconds: z.coerce.number().int().min(10).max(600).default(60),
});
export type NearbyDriversQueryInput = z.infer<typeof nearbyDriversQuerySchema>;

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

export const kycStatusSchema = z.enum([
  'not_started',
  'documents_pending',
  'under_review',
  'approved',
  'rejected',
  'suspended',
]);

export const adminDriverListQuerySchema = z.object({
  status: kycStatusSchema.optional(),
  /** Free-text match on name, phone or email. */
  q: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminDriverListQueryInput = z.infer<typeof adminDriverListQuerySchema>;

/** A rejection must always carry a reason the driver can act on. */
export const rejectionSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});
export type RejectionInput = z.infer<typeof rejectionSchema>;

export const approvalSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type ApprovalInput = z.infer<typeof approvalSchema>;

export const suspensionSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});
export type SuspensionInput = z.infer<typeof suspensionSchema>;

export const documentReviewSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    /** Required when rejecting; enforced by the refinement below. */
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision === 'approve' || (v.reason?.length ?? 0) >= 5, {
    message: 'A rejection reason of at least 5 characters is required.',
    path: ['reason'],
  });
export type DocumentReviewInput = z.infer<typeof documentReviewSchema>;
