import { z } from 'zod';

export const uuidSchema = z.string().uuid();

/** E.164 — `+` followed by 8–15 digits, country code first. */
export const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +14165550100');

export const emailSchema = z.string().email().max(254).toLowerCase();

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const localeSchema = z.enum(['en-CA', 'fr-CA']);

export const currencySchema = z.literal('CAD');

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency key must be url-safe');

/** ISO-3166-2:CA subdivision codes. Matches the CanadianProvince type. */
export const canadianProvinceSchema = z.enum([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);
