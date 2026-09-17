import type { E164Phone, ISODateTime, UserId } from './primitives';

export type UserRole = 'rider' | 'driver' | 'admin' | 'ops' | 'support';

export type KycStatus =
  | 'not_started'
  | 'documents_pending'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'suspended';

export interface User {
  id: UserId;
  phone: E164Phone | null;
  email: string | null;
  fullName: string | null;
  locale: 'en-CA' | 'fr-CA';
  roles: UserRole[];
  createdAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

export type Gender = 'male' | 'female' | 'non_binary' | 'prefer_not_to_say';

export interface EmergencyContact {
  name: string;
  /** E.164. */
  phone: string;
}

export type SavedPlaceKind = 'home' | 'work' | 'other';

/** A place a rider hearted. At most one `home` and one `work` per rider. */
export interface SavedPlace {
  id: string;
  kind: SavedPlaceKind;
  name: string;
  address: string;
  lat: number;
  lng: number;
  createdAt: ISODateTime;
}
