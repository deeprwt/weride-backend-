import { z } from 'zod';
import { idempotencyKeySchema, latLngSchema } from './common';

export const rideClassSchema = z.enum(['standard', 'xl', 'premium']);
export type RideClassInput = z.infer<typeof rideClassSchema>;

/** Fare-estimate request — no idempotency, no address (pure pricing lookup). */
export const quoteRequestSchema = z.object({
  pickup: latLngSchema,
  dropoff: latLngSchema,
  rideClass: rideClassSchema.default('standard'),
});
export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

export const rideRequestSchema = z.object({
  pickup: latLngSchema,
  dropoff: latLngSchema,
  pickupAddress: z.string().min(1).max(512),
  dropoffAddress: z.string().min(1).max(512),
  rideClass: z.enum(['standard', 'xl', 'premium']).default('standard'),
  promoCode: z.string().min(1).max(64).optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type RideRequestInput = z.infer<typeof rideRequestSchema>;

export const rideCancelSchema = z.object({
  reason: z
    .enum([
      'rider_changed_mind',
      'driver_too_far',
      'wrong_pickup',
      'wrong_destination',
      'safety_concern',
      'other',
    ])
    .default('other'),
  note: z.string().max(500).optional(),
});
export type RideCancelInput = z.infer<typeof rideCancelSchema>;
