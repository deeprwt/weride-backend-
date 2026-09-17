import { HttpException, HttpStatus } from '@nestjs/common';
import type {
  DriverDocument as DriverDocumentRow,
  DriverProfile as DriverProfileRow,
  Vehicle as VehicleRow,
} from '@prisma/client';
import { REQUIRED_DRIVER_DOCUMENTS, type DriverDocumentType, type LatLng } from '@uride/types';
import { rejectionSchema } from '@uride/validation';
import { AdminDriversService } from './admin-drivers.service';
import { AuditService } from './audit.service';
import type { PrismaService } from '../../common/prisma/prisma.module';
import type { DocumentStorage } from '../../common/storage/document-storage.interface';
import type { RequestPrincipal } from '../../common/auth/current-user.decorator';
import type { GeoService } from '../geo/geo.service';

/**
 * The availability row as this service reads it. Written out rather than
 * imported because `last_location` is an `Unsupported` geography column and the
 * generated Prisma model does not carry it.
 */
interface AvailabilityRow {
  driverId: string;
  status: string;
  vehicleId: string | null;
  headingDegrees: number | null;
  speedMps: number | null;
  lastPingAt: Date | null;
  currentRideId: string | null;
  wentOnlineAt: Date | null;
  updatedAt: Date;
}

/**
 * The driver every test starts from, mutated in place by the transaction mocks
 * below. Writing through to one fixture is what lets a case assert on the
 * AdminDriverDetail the service returns — the real row-to-wire mappers run —
 * instead of only on the arguments the service passed to Prisma.
 */
interface DriverFixture {
  profile: DriverProfileRow;
  vehicles: VehicleRow[];
  documents: DriverDocumentRow[];
  availability: AvailabilityRow | null;
}

type Mock = jest.Mock<Promise<unknown>, unknown[]>;

interface PrismaMock {
  driverProfile: { findUnique: Mock };
  auditLog: { create: Mock };
  $transaction: Mock;
}

interface TxMock {
  driverProfile: { update: Mock };
  driverDocument: { update: Mock; findMany: Mock };
  driverAvailability: { findUnique: Mock; update: Mock };
  auditLog: { create: Mock };
}

const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const INSURANCE_DOCUMENT_ID = 'doc-insurance';

/** Holds both `ops` and `support`; every decision must be attributed to `ops`. */
const ACTOR: RequestPrincipal = {
  userId: '99999999-9999-4999-8999-999999999999',
  jti: 'jti-review-desk',
  roles: ['support', 'ops'],
  exp: Math.floor(Date.now() / 1000) + 3600,
  raw: {},
};

const USER = {
  fullName: 'Jordan Tremblay',
  phone: '+14165550100',
  email: 'jordan@example.ca',
  locale: 'en-CA',
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const inAYear = (): Date => new Date(Date.now() + YEAR_MS);
const aYearAgo = (): Date => new Date(Date.now() - YEAR_MS);

describe('AdminDriversService', () => {
  let fixture: DriverFixture;
  let prisma: PrismaMock;
  let tx: TxMock;
  let geo: { getLastLocation: jest.Mock<Promise<LatLng | null>, unknown[]> };
  let service: AdminDriversService;

  beforeEach(() => {
    fixture = approvableDriver();

    tx = {
      driverProfile: { update: jest.fn() },
      driverDocument: { update: jest.fn(), findMany: jest.fn() },
      driverAvailability: { findUnique: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    };

    tx.driverProfile.update.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { data: Partial<DriverProfileRow> };
      Object.assign(fixture.profile, arg.data);
      return fixture.profile;
    });
    tx.driverDocument.update.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { id: string }; data: Partial<DriverDocumentRow> };
      const document = fixture.documents.find((d) => d.id === arg.where.id);
      if (!document) throw new Error(`test fixture has no document ${arg.where.id}`);
      Object.assign(document, arg.data);
      return document;
    });
    // Re-read inside the transaction, exactly as the service does, so the
    // "did the last required document just land" check sees the write above.
    tx.driverDocument.findMany.mockImplementation(async () =>
      fixture.documents.filter((d) => d.status === 'approved').map((d) => ({ type: d.type })),
    );
    tx.driverAvailability.findUnique.mockImplementation(async () => fixture.availability);
    tx.driverAvailability.update.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { data: Partial<AvailabilityRow> };
      if (!fixture.availability) throw new Error('test fixture has no availability row');
      Object.assign(fixture.availability, arg.data);
      return fixture.availability;
    });
    tx.auditLog.create.mockResolvedValue({});

    prisma = {
      driverProfile: { findUnique: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    // `detail()` asks for the users row; every decision pre-flight does not.
    // The include is what tells the two reads apart.
    prisma.driverProfile.findUnique.mockImplementation(async (...args: unknown[]) => {
      const arg = args[0] as { where: { userId: string }; include?: Record<string, unknown> };
      if (arg.where.userId !== DRIVER_ID) return null;
      return arg.include && 'user' in arg.include
        ? {
            ...fixture.profile,
            user: USER,
            vehicles: fixture.vehicles,
            documents: fixture.documents,
            availability: fixture.availability,
          }
        : { ...fixture.profile, vehicles: fixture.vehicles, documents: fixture.documents };
    });
    prisma.$transaction.mockImplementation(async (...args: unknown[]) => {
      const run = args[0] as (client: unknown) => Promise<unknown>;
      return run(tx);
    });

    geo = { getLastLocation: jest.fn().mockResolvedValue(null) };

    service = new AdminDriversService(
      prisma as unknown as PrismaService,
      documentStorageStub(),
      geo as unknown as GeoService,
      // The real AuditService, so the assertions cover the row it actually
      // writes and the client it writes it on, not a stubbed port.
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  // -------------------------------------------------------------------------
  // Approval gate
  // -------------------------------------------------------------------------

  describe('approve', () => {
    it('refuses while a required document is still unapproved, and names it', async () => {
      fixture.documents = approvedDocuments().map((doc) =>
        doc.type === 'insurance' ? { ...doc, status: 'pending' } : doc,
      );

      const error = await refusal(() => service.approve(ACTOR, DRIVER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.getResponse()).toMatchObject({
        code: 'driver_not_approvable',
        outstanding: ['the insurance certificate is still pending'],
      });
      // Nothing may be written, and nothing may be audited, for a refusal.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses while a required document is missing entirely', async () => {
      fixture.documents = approvedDocuments().filter((doc) => doc.type !== 'vehicle_registration');

      const error = await refusal(() => service.approve(ACTOR, DRIVER_ID, {}));

      expect(error.getResponse()).toMatchObject({
        outstanding: ['the vehicle registration has not been uploaded'],
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses while the vehicle is unapproved or the licence has lapsed', async () => {
      fixture.vehicles = [vehicleRow({ status: 'rejected' })];
      fixture.profile.licenceExpiresAt = aYearAgo();

      const error = await refusal(() => service.approve(ACTOR, DRIVER_ID, {}));

      expect(error.getResponse()).toMatchObject({
        outstanding: ['the registered vehicle is rejected', 'the licence on file has expired'],
      });
    });

    it('approves a complete application', async () => {
      const detail = await service.approve(ACTOR, DRIVER_ID, {
        note: 'checked against ServiceOntario',
      });

      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: DRIVER_ID },
        data: {
          kycStatus: 'approved',
          approvedAt: expect.any(Date),
          approvedById: ACTOR.userId,
          // A leftover reason would render in the driver app beside their now
          // active account.
          rejectionReason: null,
        },
      });
      expect(detail.profile.kycStatus).toBe('approved');
    });

    it('refuses to approve a driver who is already approved', async () => {
      fixture.profile.kycStatus = 'approved';

      const error = await refusal(() => service.approve(ACTOR, DRIVER_ID, {}));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'driver_already_approved' });
    });
  });

  // -------------------------------------------------------------------------
  // Rejection
  // -------------------------------------------------------------------------

  describe('reject', () => {
    it('demands a reason at the contract boundary', () => {
      // The controller validates the body with this schema before the service
      // ever sees it, which is why the service can treat `reason` as present.
      expect(rejectionSchema.safeParse({}).success).toBe(false);
      expect(rejectionSchema.safeParse({ reason: '   ' }).success).toBe(false);
      expect(rejectionSchema.safeParse({ reason: 'blur' }).success).toBe(false);
      expect(rejectionSchema.safeParse({ reason: 'The licence photo is unreadable.' }).success).toBe(
        true,
      );
    });

    it('moves the driver to rejected and stores the reason the app renders', async () => {
      const reason = 'The licence photo is unreadable.';

      const detail = await service.reject(ACTOR, DRIVER_ID, { reason });

      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: DRIVER_ID },
        data: { kycStatus: 'rejected', rejectionReason: reason },
      });
      expect(detail.profile.kycStatus).toBe('rejected');
      expect(detail.profile.rejectionReason).toBe(reason);
      expect(lastAuditMetadata(tx)).toMatchObject({ previousStatus: 'under_review', reason });
    });

    it('refuses to reject an approved driver, which is a suspension instead', async () => {
      fixture.profile.kycStatus = 'approved';

      const error = await refusal(() =>
        service.reject(ACTOR, DRIVER_ID, { reason: 'Complaint received about this driver.' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'driver_already_approved' });
    });
  });

  // -------------------------------------------------------------------------
  // Suspension
  // -------------------------------------------------------------------------

  describe('suspend', () => {
    const reason = 'A rider filed a safety report.';

    it('forces an online driver out of the dispatch pool', async () => {
      fixture.profile.kycStatus = 'approved';
      fixture.availability = availabilityRow({
        status: 'online',
        vehicleId: VEHICLE_ID,
        wentOnlineAt: aYearAgo(),
      });

      const detail = await service.suspend(ACTOR, DRIVER_ID, { reason });

      expect(tx.driverAvailability.update).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID },
        // wentOnlineAt describes a session that has just ended; leaving it set
        // makes the driver read as online to anything inspecting the pair.
        data: { status: 'offline', wentOnlineAt: null },
      });
      expect(detail.availability.status).toBe('offline');
      expect(detail.availability.isOnline).toBe(false);
      expect(detail.profile.suspensionReason).toBe(reason);
      expect(lastAuditMetadata(tx)).toMatchObject({ forcedOffline: true, activeRideId: null });
    });

    it('leaves a driver who is mid-trip on the trip, and records the ride', async () => {
      fixture.profile.kycStatus = 'approved';
      fixture.availability = availabilityRow({
        status: 'on_trip',
        vehicleId: VEHICLE_ID,
        currentRideId: RIDE_ID,
        wentOnlineAt: aYearAgo(),
      });

      await service.suspend(ACTOR, DRIVER_ID, { reason });

      // There is a passenger in the car, and the trip-consistency CHECK would
      // reject the write while current_ride_id is still set.
      expect(tx.driverAvailability.update).not.toHaveBeenCalled();
      expect(lastAuditMetadata(tx)).toMatchObject({
        forcedOffline: false,
        activeRideId: RIDE_ID,
      });
    });

    it('leaves an offline driver alone', async () => {
      fixture.availability = availabilityRow({ status: 'offline' });

      await service.suspend(ACTOR, DRIVER_ID, { reason });

      expect(tx.driverAvailability.update).not.toHaveBeenCalled();
      expect(lastAuditMetadata(tx)).toMatchObject({ forcedOffline: false });
    });
  });

  // -------------------------------------------------------------------------
  // Document review
  // -------------------------------------------------------------------------

  describe('reviewDocument', () => {
    it('moves the driver to under_review — never to approved — on the last document', async () => {
      fixture.profile.kycStatus = 'documents_pending';
      fixture.documents = approvedDocuments().map((doc) =>
        doc.type === 'insurance' ? { ...doc, status: 'pending' } : doc,
      );

      await service.reviewDocument(ACTOR, DRIVER_ID, INSURANCE_DOCUMENT_ID, {
        decision: 'approve',
      });

      // A human still has to read the whole file and press Approve; clearing the
      // last document is a queue move, not a KYC decision.
      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: DRIVER_ID },
        data: { kycStatus: 'under_review' },
      });
      expect(tx.driverAvailability.update).not.toHaveBeenCalled();
    });

    it('drops an approved driver back and ends their session when a document is rejected', async () => {
      fixture.profile.kycStatus = 'approved';
      fixture.availability = availabilityRow({
        status: 'online',
        vehicleId: VEHICLE_ID,
        wentOnlineAt: aYearAgo(),
      });

      const detail = await service.reviewDocument(ACTOR, DRIVER_ID, INSURANCE_DOCUMENT_ID, {
        decision: 'reject',
        reason: 'The insurance certificate expired last month.',
      });

      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: DRIVER_ID },
        data: { kycStatus: 'documents_pending' },
      });
      expect(tx.driverAvailability.update).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID },
        data: { status: 'offline', wentOnlineAt: null },
      });
      expect(detail.profile.kycStatus).toBe('documents_pending');
      expect(detail.availability.isOnline).toBe(false);
    });

    it('404s on a document belonging to another driver', async () => {
      const error = await refusal(() =>
        service.reviewDocument(ACTOR, DRIVER_ID, 'doc-someone-else', { decision: 'approve' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toMatchObject({ code: 'document_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Accountability
  // -------------------------------------------------------------------------

  describe('audit trail', () => {
    interface AuditCase {
      readonly name: string;
      readonly action: string;
      readonly resource: string;
      readonly resourceId: string;
      readonly arrange: () => void;
      readonly invoke: () => Promise<unknown>;
    }

    const cases: readonly AuditCase[] = [
      {
        name: 'approve',
        action: 'driver.approved',
        resource: 'driver_profile',
        resourceId: DRIVER_ID,
        arrange: () => undefined,
        invoke: () => service.approve(ACTOR, DRIVER_ID, {}),
      },
      {
        name: 'reject',
        action: 'driver.rejected',
        resource: 'driver_profile',
        resourceId: DRIVER_ID,
        arrange: () => undefined,
        invoke: () => service.reject(ACTOR, DRIVER_ID, { reason: 'The licence is illegible.' }),
      },
      {
        name: 'suspend',
        action: 'driver.suspended',
        resource: 'driver_profile',
        resourceId: DRIVER_ID,
        arrange: () => {
          fixture.profile.kycStatus = 'approved';
        },
        invoke: () => service.suspend(ACTOR, DRIVER_ID, { reason: 'Safety report received.' }),
      },
      {
        name: 'reinstate',
        action: 'driver.reinstated',
        resource: 'driver_profile',
        resourceId: DRIVER_ID,
        arrange: () => {
          fixture.profile.kycStatus = 'suspended';
          fixture.profile.suspendedAt = aYearAgo();
          fixture.profile.suspensionReason = 'Safety report received.';
        },
        invoke: () => service.reinstate(ACTOR, DRIVER_ID, {}),
      },
      {
        name: 'approve a document',
        action: 'driver_document.approved',
        resource: 'driver_document',
        resourceId: INSURANCE_DOCUMENT_ID,
        arrange: () => {
          fixture.profile.kycStatus = 'documents_pending';
        },
        invoke: () =>
          service.reviewDocument(ACTOR, DRIVER_ID, INSURANCE_DOCUMENT_ID, { decision: 'approve' }),
      },
      {
        name: 'reject a document',
        action: 'driver_document.rejected',
        resource: 'driver_document',
        resourceId: INSURANCE_DOCUMENT_ID,
        arrange: () => undefined,
        invoke: () =>
          service.reviewDocument(ACTOR, DRIVER_ID, INSURANCE_DOCUMENT_ID, {
            decision: 'reject',
            reason: 'The certificate has expired.',
          }),
      },
    ];

    it.each(cases)(
      '$name writes one audit row inside the transaction',
      async (testCase: AuditCase) => {
        testCase.arrange();

        await testCase.invoke();

        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            actorId: ACTOR.userId,
            // The role the action was taken UNDER, not every role the actor holds.
            actorRole: 'ops',
            action: testCase.action,
            resource: testCase.resource,
            resourceId: testCase.resourceId,
          }),
        });
        // The row must land on the transaction that made the change. Written
        // beside it, a crash in between leaves a decision nobody is accountable
        // for — which is the state we could not explain to a tribunal.
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A driver with nothing outstanding: every case breaks exactly one rule. */
function approvableDriver(): DriverFixture {
  return {
    profile: profileRow(),
    vehicles: [vehicleRow()],
    documents: approvedDocuments(),
    availability: availabilityRow(),
  };
}

function profileRow(overrides: Partial<DriverProfileRow> = {}): DriverProfileRow {
  return {
    userId: DRIVER_ID,
    kycStatus: 'under_review',
    licenceNumber: 'D1234-56789-01234',
    licenceProvince: 'ON',
    licenceExpiresAt: inAYear(),
    ratingSum: 0,
    ratingCount: 0,
    totalRides: 0,
    appliedAt: aYearAgo(),
    submittedAt: aYearAgo(),
    approvedAt: null,
    approvedById: null,
    rejectionReason: null,
    suspendedAt: null,
    suspensionReason: null,
    createdAt: aYearAgo(),
    updatedAt: aYearAgo(),
    ...overrides,
  };
}

function vehicleRow(overrides: Partial<VehicleRow> = {}): VehicleRow {
  return {
    id: VEHICLE_ID,
    driverId: DRIVER_ID,
    make: 'Toyota',
    model: 'Corolla',
    year: 2021,
    color: 'white',
    plate: 'CGBC 123',
    province: 'ON',
    rideClass: 'standard',
    seats: 4,
    status: 'approved',
    rejectionReason: null,
    isActive: true,
    createdAt: aYearAgo(),
    updatedAt: aYearAgo(),
    ...overrides,
  };
}

function documentRow(
  type: DriverDocumentType,
  overrides: Partial<DriverDocumentRow> = {},
): DriverDocumentRow {
  return {
    id: `doc-${type}`,
    driverId: DRIVER_ID,
    type,
    status: 'approved',
    storageKey: 'ab/cd/abcdef0123456789abcdef0123456789.png',
    fileName: `${type}.png`,
    mimeType: 'image/png',
    sizeBytes: 2048,
    contentSha256: null,
    expiresAt: inAYear(),
    rejectionReason: null,
    reviewedById: null,
    reviewedAt: aYearAgo(),
    uploadedAt: aYearAgo(),
    ...overrides,
  };
}

function approvedDocuments(): DriverDocumentRow[] {
  return REQUIRED_DRIVER_DOCUMENTS.map((type) => documentRow(type));
}

function availabilityRow(overrides: Partial<AvailabilityRow> = {}): AvailabilityRow {
  return {
    driverId: DRIVER_ID,
    status: 'offline',
    vehicleId: null,
    headingDegrees: null,
    speedMps: null,
    lastPingAt: null,
    currentRideId: null,
    wentOnlineAt: null,
    updatedAt: aYearAgo(),
    ...overrides,
  };
}

/** Nothing here reads a document's bytes; the stubs exist so a stray call is loud. */
function documentStorageStub(): DocumentStorage {
  return {
    put: jest.fn(),
    getStream: jest.fn(),
    stat: jest.fn(),
    delete: jest.fn(),
  } as unknown as DocumentStorage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a call that must be refused and hand the exception back, so each case can
 * assert on the `{ code }` body the dashboard switches on rather than only on
 * "something threw".
 */
async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused, but it resolved.');
}

function lastAuditMetadata(tx: TxMock): Record<string, unknown> {
  const call = tx.auditLog.create.mock.calls.at(-1);
  if (!call) throw new Error('Expected an audit row to have been written.');
  const arg = call[0] as { data: { metadata: Record<string, unknown> } };
  return arg.data.metadata;
}
