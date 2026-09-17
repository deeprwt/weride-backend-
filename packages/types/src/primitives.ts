/** Branded primitive types — catch ID confusion at compile time. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UUID = Brand<string, 'UUID'>;
export type UserId = Brand<string, 'UserId'>;
export type RideId = Brand<string, 'RideId'>;
export type DriverId = Brand<string, 'DriverId'>;
export type VehicleId = Brand<string, 'VehicleId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

/** ISO-4217 — locked to CAD for launch. */
export type Currency = 'CAD';

/** ISO-3166-2 subdivision codes for Canada. */
export type CanadianProvince =
  | 'AB'
  | 'BC'
  | 'MB'
  | 'NB'
  | 'NL'
  | 'NS'
  | 'NT'
  | 'NU'
  | 'ON'
  | 'PE'
  | 'QC'
  | 'SK'
  | 'YT';

/** E.164 phone number. */
export type E164Phone = Brand<string, 'E164Phone'>;

/** ISO-8601 timestamp string. */
export type ISODateTime = Brand<string, 'ISODateTime'>;

/** Monetary amount in minor units (cents). */
export type Cents = Brand<number, 'Cents'>;
