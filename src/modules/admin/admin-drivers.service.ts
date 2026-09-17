import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DriverAvailability as DriverAvailabilityRow,
  DriverDocument as DriverDocumentRow,
  DriverProfile as DriverProfileRow,
  Vehicle as VehicleRow,
} from '@prisma/client';
import type { Readable } from 'node:stream';
import {
  REQUIRED_DRIVER_DOCUMENTS,
  type AdminDriverCounts,
  type AdminDriverDetail,
  type AdminDriverListItem,
  type AdminDriverListPage,
  type CanadianProvince,
  type DriverAvailability,
  type DriverAvailabilityStatus,
  type DriverDocument,
  type DriverDocumentStatus,
  type DriverDocumentType,
  type DriverId,
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
  AdminDriverListQueryInput,
  ApprovalInput,
  DocumentReviewInput,
  RejectionInput,
  SuspensionInput,
} from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import { DocumentStorage } from '../../common/storage/document-storage.interface';
import type { RequestPrincipal } from '../../common/auth/current-user.decorator';
import { GeoService } from '../geo/geo.service';
import { AuditService, primaryRole } from './audit.service';

/** An open KYC document, ready for the controller to hand to the HTTP response. */
export interface DocumentDownload {
  stream: Readable;
  /** Header-safe: quotes and control characters stripped (see {@link safeFileName}). */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** Audit verbs written by this service. Centralised so a typo cannot split a driver's history. */
const ACTIONS = {
  driverApproved: 'driver.approved',
  driverRejected: 'driver.rejected',
  driverSuspended: 'driver.suspended',
  driverReinstated: 'driver.reinstated',
  documentApproved: 'driver_document.approved',
  documentRejected: 'driver_document.rejected',
  documentViewed: 'driver_document.viewed',
  vehicleApproved: 'vehicle.approved',
  vehicleRejected: 'vehicle.rejected',
} as const;

const RESOURCE_DRIVER = 'driver_profile';
const RESOURCE_DOCUMENT = 'driver_document';
const RESOURCE_VEHICLE = 'vehicle';

/** Human phrasing for the refusal messages a reviewer reads in the dashboard. */
const DOCUMENT_LABEL: Record<DriverDocumentType, string> = {
  drivers_license_front: "driver's licence (front)",
  drivers_license_back: "driver's licence (back)",
  vehicle_registration: 'vehicle registration',
  insurance: 'insurance certificate',
  profile_photo: 'profile photo',
  background_check: 'background check',
};

/** What a decision did to the driver's live dispatch session. */
interface OfflineOutcome {
  forcedOffline: boolean;
  /** Set when the driver was mid-trip and therefore left alone. */
  activeRideId: string | null;
}

/** Raw row shapes from the list/count queries — snake_case, straight from Postgres. */
interface AdminDriverListRow {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  kyc_status: string;
  vehicle_summary: string | null;
  document_count: number;
  pending_document_count: number;
  submitted_at: Date | null;
  created_at: Date;
}

interface TotalRow {
  total: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

/** Everything a decision is checked against, in one read. */
const DECISION_INCLUDE = { documents: true, vehicles: true } as const;

/** A profile loaded with the rows every decision has to be justified against. */
type DecisionProfile = DriverProfileRow & {
  documents: DriverDocumentRow[];
  vehicles: VehicleRow[];
};

/**
 * AdminDriversService — the KYC review desk.
 *
 * Two properties shape every method here. First, a decision and its audit row
 * are written in one transaction: an approval nobody is accountable for is a
 * compliance incident, so the two commit together or not at all. Second,
 * nothing in this file trusts the dashboard to have checked anything — the
 * reviewer's UI hides Approve until its checklist is green, but the gate that
 * matters is the one below, because an approved driver with an unverified
 * licence is the largest liability the platform can create with one click.
 *
 * Ownership and eligibility are enforced here rather than leaning on the RLS
 * policies in the drivers migration: the API connects to Postgres as the table
 * owner and therefore bypasses RLS entirely.
 */
@Injectable()
export class AdminDriversService {
  private readonly logger = new Logger(AdminDriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
    private readonly geo: GeoService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Queue reads
  // -------------------------------------------------------------------------

  /**
   * The review queue: one page of drivers, oldest application first.
   *
   * FIFO rather than newest-first on purpose — this is a work queue, and the
   * applicant waiting longest is the one losing income. A free-text search
   * overrides that with relevance, since at that point the reviewer is looking
   * for one person rather than working the queue.
   */
  async list(query: AdminDriverListQueryInput): Promise<AdminDriverListPage> {
    const where = this.listWhere(query);
    const orderBy = query.q
      ? Prisma.sql`ORDER BY GREATEST(
          similarity(coalesce(u."full_name", ''), ${query.q}::text),
          similarity(coalesce(u."email", ''), ${query.q}::text)
        ) DESC, p."submitted_at" ASC NULLS LAST`
      : Prisma.sql`ORDER BY p."submitted_at" ASC NULLS LAST, p."created_at" ASC`;

    // Every COUNT is cast to int. Postgres returns bigint, which Prisma hands
    // back as a JS BigInt — and BigInt throws on JSON.stringify, so the cast is
    // what keeps this endpoint from 500ing during serialisation.
    const rows = await this.prisma.$queryRaw<AdminDriverListRow[]>`
      SELECT
        p."user_id",
        u."full_name",
        u."phone",
        u."email",
        p."kyc_status",
        veh."summary" AS "vehicle_summary",
        docs."document_count",
        docs."pending_document_count",
        p."submitted_at",
        p."created_at"
      FROM "driver_profiles" p
      JOIN "users" u ON u."id" = p."user_id"
      -- LATERAL aggregates rather than GROUP BY: grouping would have to list
      -- every selected user column, and a driver with three documents and two
      -- vehicles would fan out into six rows before it collapsed them again.
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS "document_count",
          (COUNT(*) FILTER (WHERE d."status" = 'pending'))::int AS "pending_document_count"
        FROM "driver_documents" d
        WHERE d."driver_id" = p."user_id"
      ) docs ON TRUE
      LEFT JOIN LATERAL (
        SELECT v."year" || ' ' || v."make" || ' ' || v."model" || ' (' || v."plate" || ')' AS "summary"
        FROM "vehicles" v
        WHERE v."driver_id" = p."user_id" AND v."is_active"
        LIMIT 1
      ) veh ON TRUE
      ${where}
      ${orderBy}
      LIMIT ${query.limit}::int OFFSET ${query.offset}::int
    `;

    // Counted separately rather than with COUNT(*) OVER (): a window count
    // reports 0 for a page that lands past the end, which breaks the pager the
    // moment a reviewer clears the last page of a tab.
    const totals = await this.prisma.$queryRaw<TotalRow[]>`
      SELECT COUNT(*)::int AS "total"
      FROM "driver_profiles" p
      JOIN "users" u ON u."id" = p."user_id"
      ${where}
    `;

    return {
      items: rows.map(toListItem),
      total: totals[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Badge counts for the queue tabs.
   *
   * One grouped query, not six counts: the dashboard refetches this on every
   * tab switch and after every decision, and six round trips for six integers
   * is six times the pool pressure for the same answer. The users join and the
   * soft-delete filter mirror {@link list} exactly — a badge that disagrees
   * with the tab it labels costs a reviewer more time than no badge at all.
   */
  async counts(): Promise<AdminDriverCounts> {
    const rows = await this.prisma.$queryRaw<StatusCountRow[]>`
      SELECT p."kyc_status" AS "status", COUNT(*)::int AS "count"
      FROM "driver_profiles" p
      JOIN "users" u ON u."id" = p."user_id"
      WHERE u."deleted_at" IS NULL
      GROUP BY p."kyc_status"
    `;

    const counts: AdminDriverCounts = {
      not_started: 0,
      documents_pending: 0,
      under_review: 0,
      approved: 0,
      rejected: 0,
      suspended: 0,
    };
    for (const row of rows) {
      if (isCountedStatus(row.status)) counts[row.status] = row.count;
    }
    return counts;
  }

  /** The full application file: profile, vehicle, every document, live availability. */
  async detail(driverId: string): Promise<AdminDriverDetail> {
    const row = await this.prisma.driverProfile.findUnique({
      where: { userId: driverId },
      include: {
        // An explicit select, not `user: true`: the users row carries the
        // password hash and the encrypted TOTP secret, and a review screen has
        // no business pulling either into process memory.
        user: { select: { fullName: true, phone: true, email: true, locale: true } },
        // Active vehicle first, then newest — a rejected older car stays on
        // file but must never be the one the reviewer decides against.
        vehicles: { orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], take: 1 },
        documents: { orderBy: { uploadedAt: 'asc' } },
        availability: true,
      },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'driver_not_found',
        message: 'No driver profile exists for that id.',
      });
    }

    // last_location is `Unsupported` in the Prisma schema and therefore absent
    // from the generated client; GeoService owns every PostGIS read.
    const lastLocation = await this.geo.getLastLocation(driverId);
    const vehicle = row.vehicles[0] ?? null;

    return {
      profile: toProfile(row),
      fullName: row.user.fullName,
      phone: row.user.phone,
      email: row.user.email,
      locale: row.user.locale,
      vehicle: vehicle ? toVehicle(vehicle) : null,
      documents: row.documents.map(toDocument),
      availability: toAvailability(driverId, row.availability, lastLocation),
    };
  }

  /**
   * Open a KYC document for the reviewer.
   *
   * The access is audited before the bytes are opened, and a failure to record
   * it fails the request. These are government ID scans: "who looked at this
   * driver's licence, and when" is a question a privacy regulator is entitled
   * to ask, and an unrecorded view is one we could not answer.
   */
  async openDocument(
    actor: RequestPrincipal,
    driverId: string,
    documentId: string,
  ): Promise<DocumentDownload> {
    const document = await this.prisma.driverDocument.findUnique({ where: { id: documentId } });
    // The same 404 for "no such document" and "belongs to another driver", so
    // the endpoint cannot be walked to discover which document ids exist.
    if (!document || document.driverId !== driverId) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Document not found.',
      });
    }

    // stat() before getStream() for the true byte count: Content-Length is
    // taken from the store, not from the size the row recorded at upload, so a
    // divergence between the two surfaces here instead of as a truncated
    // download the reviewer would read as a corrupt licence.
    const stat = await this.storage.stat(document.storageKey);
    if (!stat) {
      this.logger.error(
        `driver_documents row ${document.id} points at missing bytes (key=${document.storageKey}).`,
      );
      throw new NotFoundException({
        code: 'document_bytes_missing',
        message: 'The stored file for this document is unavailable.',
      });
    }

    await this.audit.record({
      actorId: actor.userId,
      actorRole: primaryRole(actor.roles),
      action: ACTIONS.documentViewed,
      resource: RESOURCE_DOCUMENT,
      resourceId: document.id,
      metadata: { driverId, documentType: document.type },
    });

    return {
      stream: await this.storage.getStream(document.storageKey),
      fileName: safeFileName(document.fileName),
      // The stored mime type is the one the storage layer sniffed, never the
      // one the uploader declared — echoing a client-supplied Content-Type is
      // how an "image" becomes an HTML page served from our own origin.
      mimeType: document.mimeType,
      sizeBytes: stat.sizeBytes,
    };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Approve a driver: they may now go online and carry passengers.
   *
   * Refuses unless every required document is approved, an active vehicle is
   * approved, and the licence on file has not expired — and names what is
   * outstanding, because "cannot approve" with no reason sends the reviewer
   * hunting through five tabs for the one insurance certificate still pending.
   */
  async approve(
    actor: RequestPrincipal,
    driverId: string,
    input: ApprovalInput,
  ): Promise<AdminDriverDetail> {
    const profile = await this.loadForDecision(driverId);
    if (profile.kycStatus === 'approved') {
      throw new ConflictException({
        code: 'driver_already_approved',
        message: 'This driver is already approved.',
      });
    }
    if (profile.kycStatus === 'suspended') {
      throw new ConflictException({
        code: 'driver_suspended',
        message: 'This driver is suspended. Reinstate them instead of approving.',
      });
    }

    const outstanding = outstandingApprovalItems(profile);
    if (outstanding.length > 0) {
      throw new BadRequestException({
        code: 'driver_not_approvable',
        message: `This driver cannot be approved yet: ${outstanding.join('; ')}.`,
        outstanding,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: {
          kycStatus: 'approved',
          approvedAt: new Date(),
          approvedById: actor.userId,
          // A leftover reason from an earlier rejection would still be
          // rendering in the driver app beside their now-active account.
          rejectionReason: null,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: ACTIONS.driverApproved,
          resource: RESOURCE_DRIVER,
          resourceId: driverId,
          metadata: { previousStatus: profile.kycStatus, note: input.note ?? null },
        },
        tx,
      );
    });

    this.logger.log(`Driver ${driverId} approved by ${actor.userId}.`);
    return this.detail(driverId);
  }

  /**
   * Reject an application. The reason is mandatory (the schema enforces it) and
   * is stored on the profile because the driver app renders it verbatim — a
   * driver told only "rejected" reapplies with the same blurry licence photo,
   * and the queue pays for the review twice.
   */
  async reject(
    actor: RequestPrincipal,
    driverId: string,
    input: RejectionInput,
  ): Promise<AdminDriverDetail> {
    const profile = await this.loadForDecision(driverId);
    if (profile.kycStatus === 'approved') {
      throw new ConflictException({
        code: 'driver_already_approved',
        message: 'This driver is already approved. Suspend them instead of rejecting.',
      });
    }
    if (profile.kycStatus === 'suspended') {
      throw new ConflictException({
        code: 'driver_suspended',
        message: 'This driver is already suspended.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: { kycStatus: 'rejected', rejectionReason: input.reason },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: ACTIONS.driverRejected,
          resource: RESOURCE_DRIVER,
          resourceId: driverId,
          metadata: { previousStatus: profile.kycStatus, reason: input.reason },
        },
        tx,
      );
    });

    this.logger.log(`Driver ${driverId} rejected by ${actor.userId}.`);
    return this.detail(driverId);
  }

  /**
   * Suspend a driver — the emergency brake, usually pulled on a safety report.
   *
   * The availability row is forced offline inside the same transaction.
   * Leaving it alone would mean a driver we just suspended keeps a live
   * session, and every second of that window is one where dispatch can hand
   * them a passenger. A driver mid-trip is the one exception — see
   * {@link forceOffline}.
   */
  async suspend(
    actor: RequestPrincipal,
    driverId: string,
    input: SuspensionInput,
  ): Promise<AdminDriverDetail> {
    const profile = await this.loadForDecision(driverId);
    if (profile.kycStatus === 'suspended') {
      throw new ConflictException({
        code: 'driver_already_suspended',
        message: 'This driver is already suspended.',
      });
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: {
          kycStatus: 'suspended',
          suspendedAt: new Date(),
          suspensionReason: input.reason,
        },
      });
      const offline = await this.forceOffline(tx, driverId);
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: ACTIONS.driverSuspended,
          resource: RESOURCE_DRIVER,
          resourceId: driverId,
          metadata: {
            previousStatus: profile.kycStatus,
            reason: input.reason,
            forcedOffline: offline.forcedOffline,
            activeRideId: offline.activeRideId,
          },
        },
        tx,
      );
      return offline;
    });

    if (outcome.activeRideId) {
      this.logger.warn(
        `Driver ${driverId} was suspended mid-trip on ride ${outcome.activeRideId}; ` +
          'they stay on_trip until that ride ends and receive no further offers.',
      );
    }
    this.logger.log(`Driver ${driverId} suspended by ${actor.userId}.`);
    return this.detail(driverId);
  }

  /**
   * Lift a suspension.
   *
   * Restores the status the suspension interrupted rather than jumping to
   * `approved`: a driver suspended while their application was still pending
   * never earned approval, and granting it here would put an unvetted driver on
   * the road through the back door.
   */
  async reinstate(
    actor: RequestPrincipal,
    driverId: string,
    input: ApprovalInput,
  ): Promise<AdminDriverDetail> {
    const profile = await this.loadForDecision(driverId);
    if (profile.kycStatus !== 'suspended') {
      throw new ConflictException({
        code: 'driver_not_suspended',
        message: 'This driver is not suspended.',
      });
    }

    const restored: KycStatus = profile.approvedAt
      ? 'approved'
      : profile.submittedAt
        ? 'under_review'
        : 'documents_pending';

    await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: { kycStatus: restored, suspendedAt: null, suspensionReason: null },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: ACTIONS.driverReinstated,
          resource: RESOURCE_DRIVER,
          resourceId: driverId,
          metadata: {
            restoredStatus: restored,
            // The reason is about to be cleared from the profile; keeping it on
            // the audit row is what lets a later reviewer see what was lifted.
            liftedSuspensionReason: profile.suspensionReason,
            note: input.note ?? null,
          },
        },
        tx,
      );
    });

    this.logger.log(`Driver ${driverId} reinstated to ${restored} by ${actor.userId}.`);
    return this.detail(driverId);
  }

  /**
   * Approve or reject one document.
   *
   * Approving the last outstanding document deliberately does NOT approve the
   * driver. It moves them from `documents_pending` to `under_review`, which is
   * a queue move rather than a decision — a human still has to read the whole
   * file and press Approve, and that is the entire point of a KYC review.
   *
   * Rejecting one is decisive in the other direction: the driver drops back to
   * `documents_pending` at once, and if they were approved and online (an
   * expired insurance certificate spotted after the fact) their dispatch
   * session ends in the same transaction.
   */
  async reviewDocument(
    actor: RequestPrincipal,
    driverId: string,
    documentId: string,
    input: DocumentReviewInput,
  ): Promise<AdminDriverDetail> {
    const profile = await this.loadForDecision(driverId);
    const document = profile.documents.find((d) => d.id === documentId);
    if (!document) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Document not found.',
      });
    }

    const approving = input.decision === 'approve';
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.driverDocument.update({
        where: { id: documentId },
        data: {
          status: approving ? 'approved' : 'rejected',
          rejectionReason: approving ? null : (input.reason ?? null),
          reviewedById: actor.userId,
          reviewedAt: new Date(),
        },
      });

      const nextStatus = approving
        ? await this.statusAfterDocumentApproval(tx, driverId, profile.kycStatus)
        : statusAfterDocumentRejection(profile.kycStatus);

      let offline: OfflineOutcome = { forcedOffline: false, activeRideId: null };
      if (nextStatus) {
        await tx.driverProfile.update({
          where: { userId: driverId },
          data: { kycStatus: nextStatus },
        });
        // Only a driver who has just lost `approved` can be holding a session
        // they are no longer entitled to; the promotion to `under_review`
        // cannot have come from an approved driver.
        if (nextStatus !== 'under_review') offline = await this.forceOffline(tx, driverId);
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: approving ? ACTIONS.documentApproved : ACTIONS.documentRejected,
          resource: RESOURCE_DOCUMENT,
          resourceId: documentId,
          metadata: {
            driverId,
            documentType: document.type,
            reason: approving ? null : (input.reason ?? null),
            driverStatusBefore: profile.kycStatus,
            driverStatusAfter: nextStatus ?? profile.kycStatus,
            forcedOffline: offline.forcedOffline,
            activeRideId: offline.activeRideId,
          },
        },
        tx,
      );
      return offline;
    });

    if (outcome.activeRideId) {
      this.logger.warn(
        `Driver ${driverId} lost a required document mid-trip on ride ${outcome.activeRideId}; ` +
          'that ride is allowed to finish.',
      );
    }
    this.logger.log(
      `Document ${documentId} (${document.type}) ${approving ? 'approved' : 'rejected'} ` +
        `for driver ${driverId} by ${actor.userId}.`,
    );
    return this.detail(driverId);
  }

  /**
   * Approve or reject a driver's vehicle.
   *
   * Without this the platform deadlocks. A vehicle is created `pending` (the
   * column default), `approve()` refuses any driver without an `approved`
   * active vehicle, and nothing else in the codebase ever writes
   * `vehicles.status` — so every driver would sit in `under_review` forever and
   * no ride could ever be dispatched. Vehicle roadworthiness is a separate
   * judgement from identity, which is why it is its own decision rather than a
   * side effect of approving the driver.
   *
   * Rejecting the active vehicle of an already-approved driver pulls them back
   * to `under_review` and ends their dispatch session, for the same reason a
   * rejected document does: they are no longer entitled to carry passengers.
   */
  async reviewVehicle(
    actor: RequestPrincipal,
    driverId: string,
    vehicleId: string,
    input: DocumentReviewInput,
  ): Promise<AdminDriverDetail> {
    const profile = await this.loadForDecision(driverId);
    const vehicle = profile.vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) {
      throw new NotFoundException({
        code: 'vehicle_not_found',
        message: 'Vehicle not found for that driver.',
      });
    }

    const approving = input.decision === 'approve';
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          status: approving ? 'approved' : 'rejected',
          rejectionReason: approving ? null : (input.reason ?? null),
        },
      });

      // Rejecting the car a driver is currently cleared to drive invalidates
      // their approval. Approving a vehicle never promotes the driver on its
      // own — a human still makes that call in approve().
      const demote =
        !approving && vehicle.isActive && profile.kycStatus === 'approved'
          ? 'under_review'
          : null;

      let offline: OfflineOutcome = { forcedOffline: false, activeRideId: null };
      if (demote) {
        await tx.driverProfile.update({
          where: { userId: driverId },
          data: { kycStatus: demote },
        });
        offline = await this.forceOffline(tx, driverId);
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: primaryRole(actor.roles),
          action: approving ? ACTIONS.vehicleApproved : ACTIONS.vehicleRejected,
          resource: RESOURCE_VEHICLE,
          resourceId: vehicleId,
          metadata: {
            driverId,
            plate: vehicle.plate,
            province: vehicle.province,
            rideClass: vehicle.rideClass,
            reason: approving ? null : (input.reason ?? null),
            driverStatusBefore: profile.kycStatus,
            driverStatusAfter: demote ?? profile.kycStatus,
            forcedOffline: offline.forcedOffline,
            activeRideId: offline.activeRideId,
          },
        },
        tx,
      );
      return offline;
    });

    if (outcome.activeRideId) {
      this.logger.warn(
        `Driver ${driverId} had their vehicle rejected mid-trip on ride ${outcome.activeRideId}; ` +
          'that ride is allowed to finish.',
      );
    }
    this.logger.log(
      `Vehicle ${vehicleId} (${vehicle.plate}) ${approving ? 'approved' : 'rejected'} ` +
        `for driver ${driverId} by ${actor.userId}.`,
    );
    return this.detail(driverId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Profile plus everything a decision is checked against. 404s if unknown. */
  private async loadForDecision(driverId: string): Promise<DecisionProfile> {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: driverId },
      include: DECISION_INCLUDE,
    });
    if (!profile) {
      throw new NotFoundException({
        code: 'driver_not_found',
        message: 'No driver profile exists for that id.',
      });
    }
    return profile;
  }

  /**
   * End a driver's dispatch session as part of a decision against them.
   *
   * A driver already `on_trip` is left alone: `driver_availability` has a CHECK
   * tying `on_trip` to a non-null `current_ride_id`, so forcing them offline
   * would either fail the transaction or abandon a passenger in a moving car.
   * They get no new offers either way — the dispatch query joins
   * `driver_profiles` on `kyc_status = 'approved'` — so the trip they are on is
   * allowed to finish and the caller logs the ride id for ops to watch.
   *
   * Deliberately duplicated rather than shared with DriversService, which owns
   * go-online/go-offline: the invariant is three lines, and coupling the
   * review desk to the driver's own session control to save them would be the
   * worse trade.
   */
  private async forceOffline(
    tx: Prisma.TransactionClient,
    driverId: string,
  ): Promise<OfflineOutcome> {
    const availability = await tx.driverAvailability.findUnique({ where: { driverId } });
    if (!availability || availability.status === 'offline') {
      return { forcedOffline: false, activeRideId: null };
    }
    if (availability.status === 'on_trip') {
      return { forcedOffline: false, activeRideId: availability.currentRideId };
    }
    await tx.driverAvailability.update({
      where: { driverId },
      // wentOnlineAt is cleared with the status: it describes a session that
      // has just ended, and leaving it set makes the driver read as online to
      // anything that inspects the pair rather than the status alone.
      data: { status: 'offline', wentOnlineAt: null },
    });
    return { forcedOffline: true, activeRideId: null };
  }

  /**
   * Where an approved document leaves the driver — `under_review` once nothing
   * required is outstanding, otherwise unchanged (null).
   *
   * The document set is re-read inside the transaction rather than reused from
   * the pre-flight load, so two reviewers clearing the last two documents at
   * the same moment cannot both conclude "one is still pending" and leave the
   * application stuck in the wrong tab.
   */
  private async statusAfterDocumentApproval(
    tx: Prisma.TransactionClient,
    driverId: string,
    current: string,
  ): Promise<KycStatus | null> {
    if (current !== 'documents_pending') return null;
    const documents = await tx.driverDocument.findMany({
      where: { driverId, status: 'approved' },
      select: { type: true },
    });
    const approved = new Set(documents.map((d) => d.type));
    return REQUIRED_DRIVER_DOCUMENTS.every((type) => approved.has(type)) ? 'under_review' : null;
  }

  /** Shared WHERE for the page and its count, so the two can never disagree. */
  private listWhere(query: AdminDriverListQueryInput): Prisma.Sql {
    // A deleted account keeps its driver_profiles row (rides reference it), but
    // it is not an application anybody should be reviewing.
    const filters: Prisma.Sql[] = [Prisma.sql`u."deleted_at" IS NULL`];

    if (query.status) filters.push(Prisma.sql`p."kyc_status" = ${query.status}`);

    if (query.q) {
      const pattern = `%${escapeLikePattern(query.q)}%`;
      const digits = query.q.replace(/\D/g, '');
      // Phones are stored E.164 with no separators, so a reviewer reading
      // "(416) 555-0100" off a support ticket only matches once the formatting
      // is stripped. Trigrams are no help here — every Canadian number shares
      // the same leading digits — so this one stays a substring match.
      const phone =
        digits.length >= 3 ? Prisma.sql`OR u."phone" LIKE ${`%${digits}%`}` : Prisma.empty;
      // ILIKE catches substrings and short queries that trigram similarity
      // scores below the 0.3 default threshold; the pg_trgm `%` operator catches
      // the misspellings a reviewer types off a phone call ("Stephen"/"Steven").
      filters.push(Prisma.sql`(
        u."full_name" ILIKE ${pattern} ESCAPE '\\'
        OR u."email" ILIKE ${pattern} ESCAPE '\\'
        OR u."full_name" % ${query.q}::text
        OR u."email" % ${query.q}::text
        ${phone}
      )`);
    }

    return Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;
  }
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

/**
 * Everything blocking approval, phrased for a human. An empty array means the
 * application is complete.
 */
function outstandingApprovalItems(profile: DecisionProfile): string[] {
  const outstanding: string[] = [];

  const status = new Map(profile.documents.map((d) => [d.type, d.status]));
  for (const type of REQUIRED_DRIVER_DOCUMENTS) {
    const label = DOCUMENT_LABEL[type];
    const documentStatus = status.get(type);
    if (!documentStatus) {
      outstanding.push(`the ${label} has not been uploaded`);
    } else if (documentStatus !== 'approved') {
      outstanding.push(`the ${label} is still ${documentStatus}`);
    }
  }

  const vehicle = profile.vehicles.find((v) => v.isActive);
  if (!vehicle) {
    outstanding.push('no active vehicle is registered');
  } else if (vehicle.status !== 'approved') {
    outstanding.push(`the registered vehicle is ${vehicle.status}`);
  }

  // Checked against the profile rather than the licence image: the reviewer
  // typed this date off the licence, and approving a driver whose licence has
  // already expired is a violation we would have signed our name to.
  if (!profile.licenceExpiresAt) {
    outstanding.push('the licence expiry date is missing');
  } else if (profile.licenceExpiresAt.getTime() <= Date.now()) {
    outstanding.push('the licence on file has expired');
  }

  return outstanding;
}

/**
 * Where a rejected document leaves the driver.
 *
 * `suspended` and `rejected` drivers stay where they are — moving them to
 * `documents_pending` would quietly undo a heavier decision somebody else took.
 * An approved driver does drop back: the approval rested on a document that no
 * longer stands.
 */
function statusAfterDocumentRejection(current: string): KycStatus | null {
  if (current === 'suspended' || current === 'rejected' || current === 'documents_pending') {
    return null;
  }
  return 'documents_pending';
}

// ---------------------------------------------------------------------------
// Row -> wire mappers
// ---------------------------------------------------------------------------

function toListItem(row: AdminDriverListRow): AdminDriverListItem {
  return {
    userId: row.user_id as DriverId,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    kycStatus: row.kyc_status as KycStatus,
    vehicleSummary: row.vehicle_summary,
    documentCount: row.document_count,
    pendingDocumentCount: row.pending_document_count,
    submittedAt: isoOrNull(row.submitted_at),
    createdAt: iso(row.created_at),
  };
}

function toProfile(row: DriverProfileRow): DriverProfile {
  return {
    userId: row.userId as DriverId,
    kycStatus: row.kycStatus as KycStatus,
    licenceNumber: row.licenceNumber,
    licenceProvince: row.licenceProvince as CanadianProvince | null,
    licenceExpiresAt: isoOrNull(row.licenceExpiresAt),
    // Stored as a sum and a count so a new rating is one UPDATE; the contract
    // wants the mean, rounded to the two decimals the apps actually render.
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
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
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
    createdAt: iso(row.createdAt),
  };
}

function toDocument(row: DriverDocumentRow): DriverDocument {
  return {
    id: row.id as UUID,
    driverId: row.driverId as DriverId,
    type: row.type as DriverDocumentType,
    status: row.status as DriverDocumentStatus,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    // The reviewer's path, not the driver's `/v1/drivers/me/...` one: the same
    // bytes behind a different authorisation, and the dashboard links straight
    // to it instead of knowing how to build an admin URL.
    downloadPath: `/v1/admin/drivers/${row.driverId}/documents/${row.id}/file`,
    expiresAt: isoOrNull(row.expiresAt),
    rejectionReason: row.rejectionReason,
    reviewedAt: isoOrNull(row.reviewedAt),
    uploadedAt: iso(row.uploadedAt),
  };
}

/**
 * A driver who has never gone online has no availability row. Synthesising an
 * offline one keeps the dashboard from special-casing null on a field the
 * contract declares non-nullable.
 */
function toAvailability(
  driverId: string,
  row: DriverAvailabilityRow | null,
  lastLocation: LatLng | null,
): DriverAvailability {
  if (!row) {
    return {
      driverId: driverId as DriverId,
      status: 'offline',
      isOnline: false,
      vehicleId: null,
      lastLocation: null,
      headingDegrees: null,
      speedMps: null,
      lastPingAt: null,
      currentRideId: null,
      wentOnlineAt: null,
    };
  }
  const status = row.status as DriverAvailabilityStatus;
  return {
    driverId: row.driverId as DriverId,
    status,
    isOnline: status !== 'offline',
    vehicleId: row.vehicleId as VehicleId | null,
    lastLocation,
    headingDegrees: row.headingDegrees,
    speedMps: row.speedMps,
    lastPingAt: isoOrNull(row.lastPingAt),
    currentRideId: row.currentRideId as UUID | null,
    wentOnlineAt: isoOrNull(row.wentOnlineAt),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function iso(value: Date): ISODateTime {
  return value.toISOString() as ISODateTime;
}

function isoOrNull(value: Date | null): ISODateTime | null {
  return value ? (value.toISOString() as ISODateTime) : null;
}

function isCountedStatus(value: string): value is keyof AdminDriverCounts {
  return (
    value === 'not_started' ||
    value === 'documents_pending' ||
    value === 'under_review' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'suspended'
  );
}

/** Escape the wildcards, so a reviewer searching for `100%` does not match everyone. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The filename came off the uploader's phone and goes back out in a
 * Content-Disposition header, so a quote or a newline in it would let a driver
 * inject header syntax into the reviewer's response.
 */
function safeFileName(value: string): string {
  const cleaned = value.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'document';
}
