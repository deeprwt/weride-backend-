import type {
  CanadianProvince,
  DriverId,
  ISODateTime,
  UUID,
  VehicleId,
} from './primitives';
import type { LatLng } from './geo';
import type { RideClass } from './ride';
import type { KycStatus } from './user';

/**
 * Driver domain contract (Phase 2).
 *
 * Shared verbatim by the backend, the driver app, and the admin dashboard.
 * Wire shapes only — timestamps are ISO strings, never Date, so this file is
 * safe to import in React Native, the browser, and Node alike.
 */

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Whether a driver is reachable by the dispatcher.
 *
 * `online` means "eligible to receive offers". `on_trip` is held separately
 * from `online` so the matcher can exclude busy drivers without the driver
 * having to toggle off and back on around every ride.
 */
export type DriverAvailabilityStatus = 'offline' | 'online' | 'on_trip';

export interface DriverAvailability {
  driverId: DriverId;
  status: DriverAvailabilityStatus;
  /** Convenience: `status !== 'offline'`. */
  isOnline: boolean;
  vehicleId: VehicleId | null;
  /** Last reported position; null until the first ping of the session. */
  lastLocation: LatLng | null;
  /** Degrees clockwise from true north, 0-359. */
  headingDegrees: number | null;
  speedMps: number | null;
  lastPingAt: ISODateTime | null;
  /** Set while `status === 'on_trip'`. */
  currentRideId: UUID | null;
  wentOnlineAt: ISODateTime | null;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DriverDocumentType =
  | 'drivers_license_front'
  | 'drivers_license_back'
  | 'vehicle_registration'
  | 'insurance'
  | 'profile_photo'
  | 'background_check';

export type DriverDocumentStatus = 'pending' | 'approved' | 'rejected';

/**
 * Documents a driver must have APPROVED before they may go online.
 * `background_check` is deliberately excluded: it is uploaded by ops, not the
 * driver, and is gated at approval time rather than at go-online time.
 */
export const REQUIRED_DRIVER_DOCUMENTS: readonly DriverDocumentType[] = [
  'drivers_license_front',
  'drivers_license_back',
  'vehicle_registration',
  'insurance',
  'profile_photo',
] as const;

/** Document types that carry a meaningful expiry date. */
export const EXPIRING_DRIVER_DOCUMENTS: readonly DriverDocumentType[] = [
  'drivers_license_front',
  'drivers_license_back',
  'insurance',
  'vehicle_registration',
] as const;

export interface DriverDocument {
  id: UUID;
  driverId: DriverId;
  type: DriverDocumentType;
  status: DriverDocumentStatus;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Authenticated download path, e.g. `/v1/drivers/me/documents/:id/file`. */
  downloadPath: string;
  expiresAt: ISODateTime | null;
  rejectionReason: string | null;
  reviewedAt: ISODateTime | null;
  uploadedAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export type VehicleStatus = 'pending' | 'approved' | 'rejected';

export interface Vehicle {
  id: VehicleId;
  driverId: DriverId;
  make: string;
  model: string;
  /** Four-digit model year. */
  year: number;
  color: string;
  /** Licence plate, stored upper-cased and space-stripped. */
  plate: string;
  province: CanadianProvince;
  /** The service class this vehicle is eligible for. */
  rideClass: RideClass;
  /** Passenger seats excluding the driver. */
  seats: number;
  status: VehicleStatus;
  rejectionReason: string | null;
  /** The vehicle the driver currently drives. Exactly one per driver. */
  isActive: boolean;
  createdAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Driver profile
// ---------------------------------------------------------------------------

export interface DriverProfile {
  /** Same value as the owning `users.id` — a driver IS a user. */
  userId: DriverId;
  kycStatus: KycStatus;
  licenceNumber: string | null;
  licenceProvince: CanadianProvince | null;
  licenceExpiresAt: ISODateTime | null;
  /** Mean of all ride ratings, 1.00-5.00. Null until the first rating. */
  ratingAvg: number | null;
  ratingCount: number;
  totalRides: number;
  appliedAt: ISODateTime | null;
  submittedAt: ISODateTime | null;
  approvedAt: ISODateTime | null;
  rejectionReason: string | null;
  suspendedAt: ISODateTime | null;
  suspensionReason: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * Everything the driver app needs to render its onboarding + home screen in a
 * single round trip. `blockers` is the authoritative, human-readable list of
 * why `canGoOnline` is false — the app renders it as a checklist rather than
 * re-deriving the rules client-side.
 */
export interface DriverMe {
  profile: DriverProfile;
  vehicle: Vehicle | null;
  documents: DriverDocument[];
  availability: DriverAvailability;
  /** Required types with no approved document yet. */
  missingDocuments: DriverDocumentType[];
  canGoOnline: boolean;
  blockers: string[];
}

// ---------------------------------------------------------------------------
// Admin / KYC review
// ---------------------------------------------------------------------------

export interface AdminDriverListItem {
  userId: DriverId;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  kycStatus: KycStatus;
  vehicleSummary: string | null;
  documentCount: number;
  pendingDocumentCount: number;
  submittedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface AdminDriverListPage {
  items: AdminDriverListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminDriverDetail {
  profile: DriverProfile;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  locale: string;
  vehicle: Vehicle | null;
  documents: DriverDocument[];
  availability: DriverAvailability;
}

/** Counts for the KYC queue tab badges. */
export interface AdminDriverCounts {
  not_started: number;
  documents_pending: number;
  under_review: number;
  approved: number;
  rejected: number;
  suspended: number;
}

// ---------------------------------------------------------------------------
// Geo / dispatch
// ---------------------------------------------------------------------------

/** One candidate returned by the nearby-driver search, nearest first. */
export interface NearbyDriver {
  driverId: DriverId;
  vehicleId: VehicleId | null;
  rideClass: RideClass;
  location: LatLng;
  /** Great-circle metres from the search origin, per PostGIS. */
  distanceMeters: number;
  headingDegrees: number | null;
  lastPingAt: ISODateTime;
  ratingAvg: number | null;
}
