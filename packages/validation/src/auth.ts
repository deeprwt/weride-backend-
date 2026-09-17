import { z } from 'zod';
import { e164PhoneSchema, emailSchema, latLngSchema, localeSchema } from './common';

// ---- Phone OTP ----

export const requestOtpSchema = z.object({
  phone: e164PhoneSchema,
  channel: z.enum(['sms']).default('sms'),
});
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

export const verifyOtpSchema = z.object({
  phone: e164PhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

// ---- Refresh ----

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(256),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

// ---- Admin (email + password + TOTP) ----

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(256),
  totp: z
    .string()
    .regex(/^([0-9]{6}|[A-Za-z0-9_-]{8,12})$/, 'TOTP must be 6 digits or a recovery code')
    .optional(),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const adminTotpEnrollSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(256),
});
export type AdminTotpEnrollInput = z.infer<typeof adminTotpEnrollSchema>;

export const adminTotpConfirmSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(256),
  code: z.string().regex(/^\d{6}$/, 'TOTP must be 6 digits'),
});
export type AdminTotpConfirmInput = z.infer<typeof adminTotpConfirmSchema>;

// ---- Profile ----

export const genderSchema = z.enum(['male', 'female', 'non_binary', 'prefer_not_to_say']);

/**
 * A calendar date, not a timestamp: a birthday has no time zone, and storing it
 * as an instant shifts it by a day for anyone west of UTC.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date');

export const emergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: e164PhoneSchema,
});

export const profileUpdateSchema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  locale: localeSchema.optional(),
  email: emailSchema.nullable().optional(),
  gender: genderSchema.nullable().optional(),
  /** Must be in the past and no more than 120 years ago; see the refinement. */
  dateOfBirth: calendarDateSchema.nullable().optional(),
  /** null removes the contact; both fields are required to set one. */
  emergencyContact: emergencyContactSchema.nullable().optional(),
}).refine(
  (v) => {
    if (!v.dateOfBirth) return true;
    const dob = Date.parse(`${v.dateOfBirth}T00:00:00Z`);
    const now = Date.now();
    const maxAgeMs = 120 * 365.25 * 24 * 60 * 60 * 1000;
    return dob < now && now - dob < maxAgeMs;
  },
  { message: 'Date of birth must be in the past', path: ['dateOfBirth'] },
);
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export const savedPlaceKindSchema = z.enum(['home', 'work', 'other']);

export const savedPlaceCreateSchema = z.object({
  kind: savedPlaceKindSchema.default('other'),
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().min(1).max(512),
  location: latLngSchema,
});
export type SavedPlaceCreateInput = z.infer<typeof savedPlaceCreateSchema>;
