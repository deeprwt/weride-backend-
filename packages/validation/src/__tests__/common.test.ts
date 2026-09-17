import { e164PhoneSchema, emailSchema, latLngSchema, idempotencyKeySchema } from '../common';

describe('common schemas', () => {
  it('accepts E.164 phones', () => {
    expect(e164PhoneSchema.safeParse('+14165550100').success).toBe(true);
  });
  it('rejects non-E.164', () => {
    expect(e164PhoneSchema.safeParse('416-555-0100').success).toBe(false);
    expect(e164PhoneSchema.safeParse('+0123').success).toBe(false);
  });
  it('lower-cases emails', () => {
    const r = emailSchema.parse('User@Example.com');
    expect(r).toBe('user@example.com');
  });
  it('rejects out-of-range coords', () => {
    expect(latLngSchema.safeParse({ lat: 100, lng: 0 }).success).toBe(false);
    expect(latLngSchema.safeParse({ lat: 0, lng: 200 }).success).toBe(false);
  });
  it('rejects unsafe idempotency keys', () => {
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has spaces here xxxxxxxx').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('abc_DEF-123-456').success).toBe(true);
  });
});
