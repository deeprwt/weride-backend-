import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type DriverDocument as DriverDocumentRow,
  type DriverProfile as DriverProfileRow,
  type Vehicle as VehicleRow,
} from '@prisma/client';
import {
  REQUIRED_DRIVER_DOCUMENTS,
  type CanadianProvince,
  type DriverAvailability,
  type DriverAvailabilityStatus,
  type DriverDocumentType,
  type DriverId,
  type DriverMe,
  type DriverProfile,
  type ISODateTime,
  type KycStatus,
  type LatLng,
  type RideClass,
  type UUID,
  type Vehicle,
  type VehicleId,
  type VehicleStatus,
} from '@uride/types';
import type {
  DriverApplyInput,
  DriverProfileUpdateInput,
  GoOnlineInput,
  LocationPingBatchInput,
  LocationPingInput,
  VehicleCreateInput,
  VehicleUpdateInput,
} from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import { GeoService, type LocationWriteResult } from '../geo/geo.service';
import {
  H3DriverIndexService,
  type IndexedDriverStatus,
} from '../geo/h3-driver-index.service';
import { DRIVER_DOCUMENT_LABELS, toDriverDocument } from './driver-documents.service';

/**
 * The availability row as this module reads it.
 *
 * Declared by hand rather than imported from @prisma/client because
 * `last_location` is `Unsupported("geography(Point, 4326)")` in schema.prisma
 * and therefore absent from the generated model — the position comes from
 * GeoService, which owns every PostGIS read in the platform.
 */
interface AvailabilityRow {
  status: string;
  vehicleId: string | null;
  headingDegrees: number | null;
  speedMps: number | null;
  lastPingAt: Date | null;
  currentRideId: string | null;
  wentOnlineAt: Date | null;
}

/** Everything the eligibility rules and the /me payload are derived from, in one read. */
interface DriverSnapshot {
  profile: DriverProfileRow;
  vehicle: VehicleRow | null;
  documents: DriverDocumentRow[];
  availability: AvailabilityRow | null;
}

interface DriverEligibility {
  canGoOnline: boolean;
  blockers: string[];
  missingDocuments: DriverDocumentType[];
}

/** What a location ping did, plus the availability the driver app should believe. */
export interface LocationAck extends LocationWriteResult {
  status: DriverAvailabilityStatus;
}

/**
 * A driver may start over from these two states and no others. `rejected` is
 * included deliberately: a rejection is a decision about an application, not a
 * ban, and the ban case has its own status.
 */
const REAPPLICABLE_KYC_STATUSES: readonly string[] = ['not_started', 'rejected'];

/**
 * DriversService — the driver-facing half of onboarding and availability.
 *
 * Ownership is enforced here in addition to the RLS policies on
 * driver_profiles / vehicles / driver_availability, because the API connects to
 * Postgres as the table owner and therefore bypasses RLS — the same reason
 * RidesService re-checks ride ownership. Every method takes the caller's own id
 * and scopes its reads and writes to it; none of them accept a driver id from
 * the request.
 *
 * Every availability transition made here is mirrored into the live H3 index
 * (H3DriverIndexService) once Postgres has committed it: going online places
 * the driver, going offline — or being stood down by a re-review — removes
 * them. The index is what dispatch searches and surge counts as supply, and a
 * ping never changes a status in it, so a transition this service forgot to
 * mirror would sit wrong until the flush worker's reconcile noticed.
 */
@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly index: H3DriverIndexService,
  ) {}

  // -------------------------------------------------------------------------
  // Application + profile
  // -------------------------------------------------------------------------

  /**
   * Start (or restart) a driver application and grant the `driver` role.
   *
   * The role is granted now, but the caller's access token was minted before it
   * existed and will not carry it until the next refresh. That is why nothing on
   * DriversController is gated on @Roles('driver') — a driver who had to refresh
   * their session before they could upload a licence would simply never finish
   * onboarding. The routes authorise on the caller's own id instead.
   */
  async apply(userId: string, input: DriverApplyInput): Promise<DriverMe> {
    const licenceExpiresAt = parseFutureLicenceExpiry(input.licenceExpiresAt);

    const existing = await this.prisma.driverProfile.findUnique({
      where: { userId },
      select: { kycStatus: true },
    });
    if (existing && !REAPPLICABLE_KYC_STATUSES.includes(existing.kycStatus)) {
      throw new ConflictException({
        code: 'driver_application_exists',
        message: `You already have a driver application (${existing.kycStatus}).`,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.upsert({
        where: { userId },
        create: {
          userId,
          kycStatus: 'documents_pending',
          licenceNumber: input.licenceNumber,
          licenceProvince: input.licenceProvince,
          licenceExpiresAt,
          appliedAt: new Date(),
        },
        // Re-applying after a rejection clears the old decision; leaving
        // rejection_reason behind would have the app show a driver why they
        // were turned down for an application they have since replaced.
        update: {
          kycStatus: 'documents_pending',
          licenceNumber: input.licenceNumber,
          licenceProvince: input.licenceProvince,
          licenceExpiresAt,
          appliedAt: new Date(),
          submittedAt: null,
          rejectionReason: null,
        },
      });
      await tx.userRoleAssignment.upsert({
        where: { userId_role: { userId, role: 'driver' } },
        create: { userId, role: 'driver' },
        update: {},
      });
    });

    this.logger.log(`Driver application opened for user ${userId}.`);
    return this.me(userId);
  }

  /**
   * The single call the driver app's home screen makes: profile, vehicle,
   * documents, availability and the go-online checklist in one round trip.
   */
  async me(userId: string): Promise<DriverMe> {
    const snapshot = await this.loadSnapshot(userId);
    const eligibility = evaluateEligibility(snapshot, new Date());

    // Only worth a second query once the driver has actually reported a
    // position; before the first ping there is nothing to read.
    const lastLocation = snapshot.availability?.lastPingAt
      ? await this.geo.getLastLocation(userId)
      : null;

    return {
      profile: toDriverProfile(snapshot.profile),
      vehicle: snapshot.vehicle ? toVehicle(snapshot.vehicle) : null,
      documents: snapshot.documents.map(toDriverDocument),
      availability: toAvailability(userId, snapshot.availability, lastLocation),
      missingDocuments: eligibility.missingDocuments,
      canGoOnline: eligibility.canGoOnline,
      blockers: eligibility.blockers,
    };
  }

  /**
   * Edit the licence details on an existing application.
   *
   * Changing them after approval follows the same rule as replacing a document:
   * an approved KYC is an approval of the licence a human checked, so new
   * licence details go back into the queue instead of inheriting the old
   * decision. A PATCH that changes nothing keeps the approval.
   */
  async updateProfile(userId: string, input: DriverProfileUpdateInput): Promise<DriverMe> {
    const profile = await this.requireProfile(userId);
    const licenceExpiresAt = input.licenceExpiresAt
      ? parseFutureLicenceExpiry(input.licenceExpiresAt)
      : undefined;

    const changed =
      (input.licenceNumber !== undefined && input.licenceNumber !== profile.licenceNumber) ||
      (input.licenceProvince !== undefined &&
        input.licenceProvince !== profile.licenceProvince) ||
      (licenceExpiresAt !== undefined &&
        licenceExpiresAt.getTime() !== profile.licenceExpiresAt?.getTime());
    const reReview = changed && profile.kycStatus === 'approved';

    const stoodDown = await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.update({
        where: { userId },
        data: {
          licenceNumber: input.licenceNumber,
          licenceProvince: input.licenceProvince,
          licenceExpiresAt,
          ...(reReview ? { kycStatus: 'under_review', submittedAt: new Date() } : {}),
        },
      });
      return reReview
        ? this.standDown(tx, userId, 'their licence details changed and need re-review')
        : false;
    });
    if (stoodDown) await this.leaveLiveIndex(userId, 'licence re-review');

    return this.me(userId);
  }

  /**
   * Hand the application to the review team.
   *
   * The gate is that every required document is PRESENT, not that it is
   * approved — approval is what the reviewer is about to do. That is why this
   * list is computed separately from DriverMe.missingDocuments, which asks the
   * stricter go-online question.
   */
  async submit(userId: string): Promise<DriverMe> {
    const { profile, vehicle, documents } = await this.loadSnapshot(userId);

    if (profile.kycStatus !== 'documents_pending') {
      throw new ConflictException({
        code: 'driver_not_submittable',
        message: `An application that is ${profile.kycStatus} cannot be submitted for review.`,
      });
    }

    const uploaded = new Set(documents.map((d) => d.type));
    const missingDocuments = REQUIRED_DRIVER_DOCUMENTS.filter((type) => !uploaded.has(type));

    const details: string[] = [];
    if (missingDocuments.length > 0) {
      details.push(`Upload your ${formatList(missingDocuments.map(labelFor))}.`);
    }
    if (!vehicle) {
      details.push('Register the vehicle you drive.');
    }
    if (profile.licenceExpiresAt && profile.licenceExpiresAt <= new Date()) {
      details.push(`Your licence expired on ${asDay(profile.licenceExpiresAt)}. Update it first.`);
    }

    if (details.length > 0) {
      throw new BadRequestException({
        code: 'driver_application_incomplete',
        message: 'Your application is not ready for review yet.',
        missingDocuments,
        details,
      });
    }

    await this.prisma.driverProfile.update({
      where: { userId },
      data: { kycStatus: 'under_review', submittedAt: new Date(), rejectionReason: null },
    });

    this.logger.log(`Driver ${userId} submitted their application for review.`);
    return this.me(userId);
  }

  // -------------------------------------------------------------------------
  // Vehicle
  // -------------------------------------------------------------------------

  /** Register the car this driver drives. One active vehicle per driver. */
  async registerVehicle(userId: string, input: VehicleCreateInput): Promise<Vehicle> {
    await this.requireProfile(userId);

    try {
      const row = await this.prisma.vehicle.create({
        data: { ...input, driverId: userId, status: 'pending', isActive: true },
      });
      this.logger.log(`Driver ${userId} registered vehicle ${row.id}.`);
      return toVehicle(row);
    } catch (error) {
      throw asVehicleConflict(error);
    }
  }

  /**
   * Edit the active vehicle.
   *
   * Any real edit returns the vehicle to 'pending'. An approval is an approval
   * of THIS car — changing the plate, the class or the seat count afterwards
   * would carry an inspection onto a vehicle nobody looked at — and a rejected
   * vehicle the driver has since corrected needs a route back into the queue
   * rather than a dead end. A PATCH that changes nothing keeps the decision it
   * has, because the app re-sends the whole form on every save.
   */
  async updateVehicle(userId: string, input: VehicleUpdateInput): Promise<Vehicle> {
    const current = await this.prisma.vehicle.findFirst({
      where: { driverId: userId, isActive: true },
    });
    if (!current) {
      throw new NotFoundException({
        code: 'vehicle_not_found',
        message: 'Register a vehicle before editing one.',
      });
    }

    const changed =
      (input.make !== undefined && input.make !== current.make) ||
      (input.model !== undefined && input.model !== current.model) ||
      (input.year !== undefined && input.year !== current.year) ||
      (input.color !== undefined && input.color !== current.color) ||
      (input.plate !== undefined && input.plate !== current.plate) ||
      (input.province !== undefined && input.province !== current.province) ||
      (input.rideClass !== undefined && input.rideClass !== current.rideClass) ||
      (input.seats !== undefined && input.seats !== current.seats);
    const reReview = changed && current.status !== 'pending';

    let result: { row: VehicleRow; stoodDown: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.vehicle.update({
          where: { id: current.id },
          data: {
            ...input,
            ...(reReview ? { status: 'pending', rejectionReason: null } : {}),
          },
        });
        const stoodDown = reReview
          ? await this.standDown(tx, userId, 'their vehicle changed and is pending re-approval')
          : false;
        return { row: updated, stoodDown };
      });
    } catch (error) {
      throw asVehicleConflict(error);
    }

    if (result.stoodDown) await this.leaveLiveIndex(userId, 'vehicle re-approval');
    return toVehicle(result.row);
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  /**
   * Join the dispatch pool.
   *
   * Eligibility is evaluated through the same function GET /drivers/me renders
   * as a checklist, so the app can never show a green button the server would
   * refuse — or refuse for a reason the app cannot explain.
   */
  async goOnline(userId: string, input: GoOnlineInput): Promise<DriverAvailability> {
    const snapshot = await this.loadSnapshot(userId);
    const eligibility = evaluateEligibility(snapshot, new Date());
    const vehicle = snapshot.vehicle;

    if (!eligibility.canGoOnline || !vehicle) {
      throw new ForbiddenException({
        code: 'driver_not_eligible',
        message: 'You are not cleared to go online yet.',
        blockers: eligibility.blockers,
      });
    }
    if (input.vehicleId && input.vehicleId !== vehicle.id) {
      throw new BadRequestException({
        code: 'vehicle_not_available',
        message: 'That is not the approved vehicle on your account.',
      });
    }

    const current = snapshot.availability;

    // Already on a trip: this is a no-op that must not touch `status` or
    // `current_ride_id`. Resetting to 'online' would unassign a ride with a
    // passenger in the car — and the trip-consistency CHECK would reject the
    // write anyway. The ping still lands, so the rider keeps seeing the car
    // move, which is the whole reason a driver whose app restarted mid-trip
    // presses this button.
    if (current?.status === 'on_trip') {
      await this.geo.recordLocation(
        userId,
        { location: input.location },
        current.currentRideId ?? undefined,
      );
      // Re-attach the trip in the live index as well. A ping never changes the
      // status an entry already holds, so an entry that went wrong while the
      // app was down — an accept whose index write was lost — would otherwise
      // stay wrong until the next reconcile. The driver saying "I am here, on
      // this trip" is the best moment to put it right.
      if (current.currentRideId) {
        await this.placeInLiveIndex(userId, input.location, 'on_trip', current.currentRideId);
      }
      this.logger.debug(`Driver ${userId} pressed go-online while on a trip; status unchanged.`);
      return toAvailability(userId, current, input.location);
    }

    // Position first, status second. A driver must never enter the dispatch
    // pool at the corner where they parked last night; if the ping write fails
    // they simply stay offline. recordLocation upserts the availability row, so
    // it is there for the update below even on a driver's first ever shift.
    await this.geo.recordLocation(userId, { location: input.location });

    const wentOnlineAt =
      current?.status === 'online' && current.wentOnlineAt ? current.wentOnlineAt : new Date();
    const row = await this.prisma.driverAvailability.update({
      where: { driverId: userId },
      data: { status: 'online', vehicleId: vehicle.id, wentOnlineAt },
    });

    // Now, and not before the UPDATE. A ping never sets a status, so the ping
    // above left this driver as the index already had them — for a driver
    // starting a shift, absent, or marked offline from the row as it read
    // before the UPDATE. This write is what puts them where a wave can find
    // them, and made after the commit it outranks any flush-worker reconcile
    // that read the older row.
    await this.placeInLiveIndex(userId, input.location, 'online', null);

    this.logger.log(`Driver ${userId} is online in vehicle ${vehicle.id}.`);
    return toAvailability(userId, row, input.location);
  }

  /** Leave the dispatch pool. Idempotent — the app fires this on logout and on background. */
  async goOffline(userId: string): Promise<DriverAvailability> {
    const current = await this.prisma.driverAvailability.findUnique({
      where: { driverId: userId },
    });
    if (!current) {
      await this.requireProfile(userId);
      return toAvailability(userId, null, null);
    }

    // Going offline mid-trip would strand a rider in a car the dispatcher has
    // stopped tracking, and would violate the trip-consistency CHECK besides.
    // The trip has to end first.
    if (current.status === 'on_trip') {
      throw new ConflictException({
        code: 'driver_on_trip',
        message: 'Finish or cancel your current trip before going offline.',
      });
    }

    const row =
      current.status === 'offline'
        ? current
        : await this.prisma.driverAvailability.update({
            where: { driverId: userId },
            data: { status: 'offline', wentOnlineAt: null },
          });

    // Even when the row already read offline. The removal is idempotent, and
    // the heartbeat sweeper and the admin desk take drivers offline in Postgres
    // without touching the index — this is the moment the driver's own app
    // confirms it, so any entry they left behind stops counting as supply now
    // rather than when it expires.
    await this.leaveLiveIndex(userId, 'went offline');

    return toAvailability(userId, row, await this.geo.getLastLocation(userId));
  }

  /**
   * One live position.
   *
   * A ping never changes `status`. The heartbeat sweeper takes a silent driver
   * offline after DRIVER_ONLINE_HEARTBEAT_SECONDS, and a phone returning from a
   * dead zone must not put itself back in the dispatch pool without the
   * eligibility check that POST /online performs — the ack carries the server's
   * view of the status back so the app knows it has to ask again.
   */
  async recordPing(userId: string, input: LocationPingInput): Promise<LocationAck> {
    const current = await this.currentAvailability(userId);
    const result = await this.geo.recordLocation(userId, input, current.currentRideId ?? undefined);
    return { ...result, status: current.status };
  }

  /** Flush the queue the app buffered through a connectivity gap. Oldest ping first. */
  async recordPingBatch(userId: string, input: LocationPingBatchInput): Promise<LocationAck> {
    const current = await this.currentAvailability(userId);
    const result = await this.geo.recordLocationBatch(
      userId,
      input.pings,
      current.currentRideId ?? undefined,
    );
    return { ...result, status: current.status };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Load the whole driver in one query. Both /me and the availability
   * transitions run off this, which is what keeps the go-online rules from
   * being evaluated against two different reads of the same driver.
   */
  private async loadSnapshot(userId: string): Promise<DriverSnapshot> {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        // One active vehicle per driver is a database invariant (a partial
        // unique index), so take: 1 cannot be hiding a second one.
        vehicles: { where: { isActive: true }, take: 1 },
        documents: { orderBy: { uploadedAt: 'desc' } },
        availability: true,
      },
    });
    if (!profile) {
      throw new NotFoundException({
        code: 'driver_profile_not_found',
        message: 'You have not applied to drive yet.',
      });
    }

    return {
      profile,
      vehicle: profile.vehicles[0] ?? null,
      documents: profile.documents,
      availability: profile.availability ?? null,
    };
  }

  private async requireProfile(userId: string): Promise<DriverProfileRow> {
    const profile = await this.prisma.driverProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new NotFoundException({
        code: 'driver_profile_not_found',
        message: 'You have not applied to drive yet.',
      });
    }
    return profile;
  }

  /**
   * Status and current ride without paying for the full snapshot — a ping is the
   * highest-volume call in the system.
   *
   * A driver who has never gone online has no availability row yet; the profile
   * lookup is only there so they get `driver_profile_not_found` instead of the
   * foreign-key violation GeoService would otherwise raise.
   */
  private async currentAvailability(
    userId: string,
  ): Promise<{ status: DriverAvailabilityStatus; currentRideId: string | null }> {
    const row = await this.prisma.driverAvailability.findUnique({
      where: { driverId: userId },
      select: { status: true, currentRideId: true },
    });
    if (row) {
      return { status: row.status as DriverAvailabilityStatus, currentRideId: row.currentRideId };
    }
    await this.requireProfile(userId);
    return { status: 'offline', currentRideId: null };
  }

  /**
   * Take a driver out of the dispatch pool after something revoked their
   * eligibility. `on_trip` rows are deliberately untouched: there is a passenger
   * in the car, and the trip-consistency CHECK would reject the write while
   * current_ride_id is still set.
   *
   * Returns whether anyone was actually taken offline, so the caller can remove
   * them from the live index once the transaction has committed — not from in
   * here, where a rollback would leave the index ahead of the row.
   */
  private async standDown(
    tx: Prisma.TransactionClient,
    driverId: string,
    reason: string,
  ): Promise<boolean> {
    const { count } = await tx.driverAvailability.updateMany({
      where: { driverId, status: 'online' },
      data: { status: 'offline', wentOnlineAt: null },
    });
    if (count > 0) {
      this.logger.warn(`Driver ${driverId} taken offline: ${reason}.`);
    }
    return count > 0;
  }

  /**
   * Place a driver in the live index with a status Postgres has just committed.
   *
   * Best-effort, after the commit, for the same reasons as
   * {@link leaveLiveIndex}. `upsert` keeps a newer position the index already
   * holds, so a ping that raced this request is not dragged back to where the
   * button was pressed.
   */
  private async placeInLiveIndex(
    driverId: string,
    location: LatLng,
    status: IndexedDriverStatus,
    rideId: string | null,
  ): Promise<void> {
    try {
      await this.index.upsert({
        driverId,
        lat: location.lat,
        lng: location.lng,
        headingDegrees: null,
        speedMps: null,
        recordedAtMs: Date.now(),
        rideId,
        status,
      });
    } catch (error) {
      this.logger.warn(
        `Live index not updated for driver ${driverId} (${status}); reconciled from ` +
          `driver_availability on a later ping: ${describeError(error)}`,
      );
    }
  }

  /**
   * Remove a driver from the live index after Postgres has taken them offline.
   *
   * Best-effort: by now the driver's request has succeeded in the database, and
   * the database is what dispatch re-checks every wave — MatchingService's
   * eligibility query reads this row's status — so an entry left behind cannot
   * draw an offer. What it costs is a few seconds of surge counting the driver
   * as supply, until the flush worker reconciles the entry or it expires. A
   * Redis blip is not a reason to tell a driver they failed to go offline.
   */
  private async leaveLiveIndex(driverId: string, reason: string): Promise<void> {
    try {
      await this.index.remove(driverId);
    } catch (error) {
      this.logger.warn(
        `Driver ${driverId} not removed from the live index (${reason}); reconciled from ` +
          `driver_availability or expired: ${describeError(error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Eligibility — the one place the go-online rules live
// ---------------------------------------------------------------------------

/**
 * Decide whether a driver may go online, and say why not in words the app can
 * render verbatim.
 *
 * GET /drivers/me and POST /drivers/me/online both call this, which is the
 * point: the checklist the driver reads and the gate the server enforces are
 * the same computation, so the button can never be green on a driver the API
 * would refuse.
 */
function evaluateEligibility(snapshot: DriverSnapshot, now: Date): DriverEligibility {
  const { profile, vehicle, documents } = snapshot;
  const blockers: string[] = [];

  // A suspension lives in its own columns rather than only in kyc_status: ops
  // can suspend an already-approved driver, and the schema carries no lift date
  // on purpose, so a suspension stays in force until ops clears suspended_at.
  // There is nothing to age out here — an unexpired suspension is simply any
  // suspension still on the row.
  if (profile.kycStatus === 'suspended' || profile.suspendedAt !== null) {
    blockers.push(
      `Your account is suspended: ${profile.suspensionReason ?? 'contact support to appeal'}.`,
    );
  } else {
    const kyc = kycBlocker(profile.kycStatus, profile.rejectionReason);
    if (kyc) blockers.push(kyc);
  }

  if (profile.licenceExpiresAt && profile.licenceExpiresAt <= now) {
    blockers.push(
      `Your licence expired on ${asDay(profile.licenceExpiresAt)}. Update your licence details.`,
    );
  }

  if (!vehicle) {
    blockers.push('Register the vehicle you drive.');
  } else if (vehicle.status === 'rejected') {
    const reason = vehicle.rejectionReason ?? 'no reason was recorded';
    blockers.push(`Your ${vehicle.make} ${vehicle.model} was rejected: ${reason}.`);
  } else if (vehicle.status !== 'approved') {
    blockers.push(`Your ${vehicle.make} ${vehicle.model} is waiting for approval.`);
  }

  const byType = new Map(documents.map((doc): [string, DriverDocumentRow] => [doc.type, doc]));
  const missingDocuments: DriverDocumentType[] = [];
  const notUploaded: string[] = [];
  const awaitingReview: string[] = [];

  for (const type of REQUIRED_DRIVER_DOCUMENTS) {
    const doc = byType.get(type);
    const label = labelFor(type);

    if (!doc) {
      missingDocuments.push(type);
      notUploaded.push(label);
      continue;
    }
    if (doc.status === 'rejected') {
      missingDocuments.push(type);
      const reason = doc.rejectionReason ?? 'no reason was recorded';
      blockers.push(`Your ${label} was rejected: ${reason}. Upload a new one.`);
      continue;
    }
    if (doc.status !== 'approved') {
      missingDocuments.push(type);
      awaitingReview.push(label);
      continue;
    }
    // An approved document that has since lapsed is worse than a missing one:
    // it is not in anyone's review queue, so nothing else in the system will
    // ever surface it. This is the only check standing between an expired
    // insurance certificate and a driver taking fares on it.
    if (doc.expiresAt && doc.expiresAt <= now) {
      blockers.push(`Your ${label} expired on ${asDay(doc.expiresAt)}. Upload a current copy.`);
    }
  }

  if (notUploaded.length > 0) blockers.push(`Upload your ${formatList(notUploaded)}.`);
  // Only meaningful once the application has actually been handed over: before
  // that, an unapproved document is not waiting on anybody, and the kyc blocker
  // above already tells the driver to submit.
  if (awaitingReview.length > 0 && profile.submittedAt !== null) {
    blockers.push(`We are still reviewing your ${formatList(awaitingReview)}.`);
  }

  return { canGoOnline: blockers.length === 0, blockers, missingDocuments };
}

/**
 * Switches on the raw column rather than the KycStatus union: kyc_status is TEXT
 * with a CHECK constraint, so a value the contract has not learned about yet
 * must still produce a blocker rather than silently clearing the driver.
 */
function kycBlocker(kycStatus: string, rejectionReason: string | null): string | null {
  switch (kycStatus) {
    case 'approved':
      return null;
    case 'not_started':
      return 'Finish your driver application.';
    case 'documents_pending':
      return 'Submit your application for review.';
    case 'under_review':
      return 'Your application is with our review team.';
    case 'rejected':
      return `Your application was rejected: ${rejectionReason ?? 'no reason was recorded'}.`;
    default:
      return 'Your driver account has not been approved.';
  }
}

// ---------------------------------------------------------------------------
// Row -> wire mappers
// ---------------------------------------------------------------------------

function toDriverProfile(row: DriverProfileRow): DriverProfile {
  return {
    userId: row.userId as DriverId,
    kycStatus: row.kycStatus as KycStatus,
    licenceNumber: row.licenceNumber,
    licenceProvince: row.licenceProvince as CanadianProvince | null,
    licenceExpiresAt: isoOrNull(row.licenceExpiresAt),
    // The table stores the running sum and count; the wire carries the mean,
    // rounded to the two decimals every surface displays.
    ratingAvg:
      row.ratingCount > 0 ? Math.round((row.ratingSum / row.ratingCount) * 100) / 100 : null,
    ratingCount: row.ratingCount,
    totalRides: row.totalRides,
    appliedAt: isoOrNull(row.appliedAt),
    submittedAt: isoOrNull(row.submittedAt),
    approvedAt: isoOrNull(row.approvedAt),
    rejectionReason: row.rejectionReason,
    suspendedAt: isoOrNull(row.suspendedAt),
    suspensionReason: row.suspensionReason,
    createdAt: row.createdAt.toISOString() as ISODateTime,
    updatedAt: row.updatedAt.toISOString() as ISODateTime,
  };
}

function toVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id as VehicleId,
    driverId: row.driverId as DriverId,
    make: row.make,
    model: row.model,
    year: row.year,
    color: row.color,
    plate: row.plate,
    province: row.province as CanadianProvince,
    rideClass: row.rideClass as RideClass,
    seats: row.seats,
    status: row.status as VehicleStatus,
    rejectionReason: row.rejectionReason,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString() as ISODateTime,
  };
}

/**
 * A driver who has never gone online has no availability row at all — the first
 * ping creates it. The wire shape still needs one, so an absent row reads as a
 * plain offline driver.
 */
function toAvailability(
  driverId: string,
  row: AvailabilityRow | null,
  lastLocation: LatLng | null,
): DriverAvailability {
  const status = (row?.status ?? 'offline') as DriverAvailabilityStatus;
  return {
    driverId: driverId as DriverId,
    status,
    isOnline: status !== 'offline',
    vehicleId: (row?.vehicleId ?? null) as VehicleId | null,
    lastLocation,
    headingDegrees: row?.headingDegrees ?? null,
    speedMps: row?.speedMps ?? null,
    lastPingAt: isoOrNull(row?.lastPingAt ?? null),
    currentRideId: (row?.currentRideId ?? null) as UUID | null,
    wentOnlineAt: isoOrNull(row?.wentOnlineAt ?? null),
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * The zod schema proves the string is a timestamp; only the service knows an
 * application may not be opened or amended with a licence that has already run
 * out. Catching it here rather than at go-online time saves a reviewer the trip.
 */
function parseFutureLicenceExpiry(raw: string): Date {
  const expiresAt = new Date(raw);
  if (expiresAt.getTime() <= Date.now()) {
    throw new BadRequestException({
      code: 'licence_expired',
      message: `That licence expired on ${asDay(expiresAt)}. Enter a current licence.`,
    });
  }
  return expiresAt;
}

/**
 * Translate a unique-constraint violation into something the driver can act on.
 *
 * The one-active-vehicle-per-driver index is partial, which Prisma cannot model,
 * so it arrives as a bare P2002 naming the raw constraint rather than as a known
 * @@unique. Both cases are told apart by whether the plate is implicated.
 */
function asVehicleConflict(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return error;
  }
  const violated = JSON.stringify(error.meta ?? {});
  if (violated.includes('plate')) {
    return new ConflictException({
      code: 'plate_already_registered',
      message: 'That plate is already registered in this province.',
    });
  }
  return new ConflictException({
    code: 'vehicle_already_registered',
    message: 'You already have an active vehicle. Edit it instead of registering another.',
  });
}

function labelFor(type: DriverDocumentType): string {
  return DRIVER_DOCUMENT_LABELS[type];
}

/** "a", "a and b", "a, b and c" — blockers are rendered verbatim by the driver app. */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** ISO calendar day — dates in driver-facing copy must not drift with the server locale. */
function asDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isoOrNull(value: Date | null): ISODateTime | null {
  return value ? (value.toISOString() as ISODateTime) : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
