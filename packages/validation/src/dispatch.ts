import { z } from 'zod';
import { latLngSchema, uuidSchema } from './common';

/**
 * Dispatch input validation (Phase 3).
 *
 * The offer/accept path is the one place in the platform where two clients race
 * for the same row, so these schemas are deliberately strict: anything
 * ambiguous here becomes a double-assigned driver.
 */

// ---------------------------------------------------------------------------
// Driver responses to an offer
// ---------------------------------------------------------------------------

export const offerDeclineReasonSchema = z.enum([
  'too_far',
  'wrong_direction',
  'taking_a_break',
  'vehicle_issue',
  'other',
]);

export const offerAcceptSchema = z.object({
  /**
   * Where the driver was when they tapped accept. Used to recompute the ETA the
   * rider is shown, rather than trusting the estimate made when the offer was
   * created — the driver may have moved since.
   */
  location: latLngSchema.optional(),
});
export type OfferAcceptInput = z.infer<typeof offerAcceptSchema>;

export const offerDeclineSchema = z.object({
  reason: offerDeclineReasonSchema.default('other'),
});
export type OfferDeclineInput = z.infer<typeof offerDeclineSchema>;

// ---------------------------------------------------------------------------
// Driver-side trip progression
// ---------------------------------------------------------------------------

export const driverArrivedSchema = z.object({
  location: latLngSchema.optional(),
});
export type DriverArrivedInput = z.infer<typeof driverArrivedSchema>;

/**
 * Starting a trip requires the 4-digit code the rider reads out.
 *
 * This is the anti-fraud control on the whole flow: without it a driver can
 * mark a trip started and completed without the rider ever being in the car,
 * which is the standard way fake-ride payout fraud works.
 */
export const rideStartSchema = z.object({
  pickupOtp: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'The pickup code is 4 digits'),
  location: latLngSchema.optional(),
});
export type RideStartInput = z.infer<typeof rideStartSchema>;

export const rideCompleteSchema = z.object({
  location: latLngSchema.optional(),
  /** Odometer-style actual distance, if the app tracked it. */
  actualDistanceMeters: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type RideCompleteInput = z.infer<typeof rideCompleteSchema>;

export const driverCancelSchema = z.object({
  reason: z
    .enum([
      'rider_no_show',
      'rider_cancelled_in_person',
      'vehicle_issue',
      'safety_concern',
      'cannot_reach_pickup',
      'other',
    ])
    .default('other'),
  note: z.string().trim().max(500).optional(),
});
export type DriverCancelInput = z.infer<typeof driverCancelSchema>;

// ---------------------------------------------------------------------------
// Realtime socket messages
// ---------------------------------------------------------------------------

export const rideSubscribeSchema = z.object({
  rideId: uuidSchema,
});
export type RideSubscribeInput = z.infer<typeof rideSubscribeSchema>;

/**
 * Location frames arriving over the socket.
 *
 * Same shape as the REST ping minus the batch affordances: a socket frame is
 * by definition current, so there is no backfill case to model here.
 */
export const rtDriverLocationSchema = z.object({
  location: latLngSchema,
  headingDegrees: z.coerce.number().min(0).max(360).optional(),
  speedMps: z.coerce.number().min(0).max(90).optional(),
  /** Present only while on a trip; the gateway verifies it against the driver. */
  rideId: uuidSchema.optional(),
});
export type RtDriverLocationInput = z.infer<typeof rtDriverLocationSchema>;

// ---------------------------------------------------------------------------
// Admin / ops dispatch controls
// ---------------------------------------------------------------------------

export const rideReassignSchema = z.object({
  driverId: uuidSchema,
  reason: z.string().trim().min(5).max(500),
});
export type RideReassignInput = z.infer<typeof rideReassignSchema>;

export const adminRideListQuerySchema = z.object({
  status: z.string().trim().max(32).optional(),
  riderId: uuidSchema.optional(),
  driverId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminRideListQueryInput = z.infer<typeof adminRideListQuerySchema>;
