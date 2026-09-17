export interface SendOtpResult {
  /**
   * Provider-defined challenge id. For Twilio Verify this is a Verification SID.
   * For LocalDev we return the phone-keyed Redis key so verification can locate it.
   */
  challengeId?: string;
}

export interface VerifyOtpInput {
  phone: string;
  code: string;
}

export type VerifyOtpOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid_code' | 'expired' | 'too_many_attempts' };

export abstract class OtpProvider {
  abstract send(phone: string): Promise<SendOtpResult>;
  abstract verify(input: VerifyOtpInput): Promise<VerifyOtpOutcome>;
}

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');
