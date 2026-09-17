import { HttpException, HttpStatus } from '@nestjs/common';
import type {
  DriverDocument as DriverDocumentRow,
  DriverProfile as DriverProfileRow,
  Vehicle as VehicleRow,
} from '@prisma/client';
import { REQUIRED_DRIVER_DOCUMENTS, type DriverDocumentType, type LatLng } from '@uride/types';
import { DriversService } from './drivers.service';
import type { PrismaService } from '../../common/prisma/prisma.module';
import type { GeoService, LocationWriteResult } from '../geo/geo.service';
import type { H3DriverIndexService } from '../geo/h3-driver-index.service';

/**
 * Mirrors the hand-declared row in drivers.service.ts, for the same reason: the
 * availability row carries an `Unsupported` geography column that the generated
 * Prisma model does not expose, so the shape is written out rather than imported.
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

/** What `loadSnapshot` gets back from its single include-everything read. */
interface SnapshotRow extends DriverProfileRow {
  vehicles: VehicleRow[];
  documents: DriverDocumentRow[];
  availability: AvailabilityRow | null;
}

interface PrismaMock {
  driverProfile: {
    findUnique: jest.Mock<Promise<unknown>, unknown[]>;
    update: jest.Mock<Promise<unknown>, unknown[]>;
  };
  driverAvailability: {
    findUnique: jest.Mock<Promise<unknown>, unknown[]>;
    update: jest.Mock<Promise<unknown>, unknown[]>;
  };
}

interface GeoMock {
  getLastLocation: jest.Mock<Promise<LatLng | null>, unknown[]>;
  recordLocation: jest.Mock<Promise<LocationWriteResult>, unknown[]>;
}

/** The live H3 index: every committed availability change is mirrored into it. */
interface IndexMock {
  upsert: jest.Mock<Promise<unknown>, unknown[]>;
  remove: jest.Mock<Promise<void>, unknown[]>;
}

const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const RIDE_ID = '33333333-3333-4333-8333-333333333333';
const TORONTO: LatLng = { lat: 43.6532, lng: -79.3832 };

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const inAYear = (): Date => new Date(Date.now() + YEAR_MS);
const aYearAgo = (): Date => new Date(Date.now() - YEAR_MS);

describe('DriversService', () => {
  let prisma: PrismaMock;
  let geo: GeoMock;
  let index: IndexMock;
  let service: DriversService;

  beforeEach(() => {
    prisma = {
      driverProfile: { findUnique: jest.fn(), update: jest.fn() },
      driverAvailability: { findUnique: jest.fn(), update: jest.fn() },
    };
    geo = {
      getLastLocation: jest.fn().mockResolvedValue(null),
      recordLocation: jest.fn().mockResolvedValue({
        pointsRecorded: 1,
        availabilityUpdated: true,
        latestRecordedAt: new Date().toISOString(),
      }),
    };
    index = {
      upsert: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    service = new DriversService(
      prisma as unknown as PrismaService,
      geo as unknown as GeoService,
      index as unknown as H3DriverIndexService,
    );
  });

  // -------------------------------------------------------------------------
  // Eligibility — the checklist GET /drivers/me renders and POST /online enforces
  // -------------------------------------------------------------------------

  describe('canGoOnline / blockers', () => {
    interface EligibilityCase {
      readonly name: string;
      readonly snapshot: SnapshotRow;
      readonly canGoOnline: boolean;
      readonly blocker: RegExp | null;
      readonly missingDocuments: readonly DriverDocumentType[];
    }

    const cases: readonly EligibilityCase[] = [
      {
        name: 'all clear',
        snapshot: snapshotRow(),
        canGoOnline: true,
        blocker: null,
        missingDocuments: [],
      },
      {
        name: 'kyc not approved',
        snapshot: snapshotRow({ kycStatus: 'under_review', approvedAt: null }),
        canGoOnline: false,
        blocker: /application is with our review team/,
        missingDocuments: [],
      },
      {
        name: 'no vehicle',
        snapshot: snapshotRow({ vehicles: [] }),
        canGoOnline: false,
        blocker: /Register the vehicle you drive/,
        missingDocuments: [],
      },
      {
        name: 'vehicle not approved',
        snapshot: snapshotRow({ vehicles: [vehicleRow({ status: 'pending' })] }),
        canGoOnline: false,
        blocker: /Toyota Corolla is waiting for approval/,
        missingDocuments: [],
      },
      {
        name: 'missing required document',
        snapshot: snapshotRow({
          documents: approvedDocuments().filter((doc) => doc.type !== 'insurance'),
        }),
        canGoOnline: false,
        blocker: /Upload your insurance certificate\./,
        missingDocuments: ['insurance'],
      },
      {
        name: 'expired document',
        snapshot: snapshotRow({
          documents: approvedDocuments().map((doc) =>
            doc.type === 'insurance' ? { ...doc, expiresAt: aYearAgo() } : doc,
          ),
        }),
        canGoOnline: false,
        blocker: /insurance certificate expired on \d{4}-\d{2}-\d{2}/,
        // An approved-but-lapsed document is not "missing": it is on file, it is
        // in nobody's review queue, and only this blocker will ever surface it.
        missingDocuments: [],
      },
      {
        name: 'suspended',
        snapshot: snapshotRow({
          kycStatus: 'suspended',
          suspendedAt: new Date(),
          suspensionReason: 'a safety report is under investigation',
        }),
        canGoOnline: false,
        blocker: /account is suspended: a safety report is under investigation/,
        missingDocuments: [],
      },
    ];

    it.each(cases)(
      '$name',
      async ({ snapshot, canGoOnline, blocker, missingDocuments }: EligibilityCase) => {
        prisma.driverProfile.findUnique.mockResolvedValue(snapshot);

        const me = await service.me(DRIVER_ID);

        expect(me.canGoOnline).toBe(canGoOnline);
        expect(me.missingDocuments).toEqual(missingDocuments);
        if (blocker) {
          expect(me.blockers.some((line) => blocker.test(line))).toBe(true);
        } else {
          // The clear case has to be genuinely empty: a stray blocker would keep
          // the app's button grey with no way for the driver to find out why.
          expect(me.blockers).toEqual([]);
        }
      },
    );

    it('refuses to go online for a driver the checklist blocks, echoing the same reasons', async () => {
      const snapshot = snapshotRow({ vehicles: [vehicleRow({ status: 'pending' })] });
      prisma.driverProfile.findUnique.mockResolvedValue(snapshot);
      const { blockers } = await service.me(DRIVER_ID);

      const error = await refusal(() => service.goOnline(DRIVER_ID, { location: TORONTO }));

      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(error.getResponse()).toMatchObject({ code: 'driver_not_eligible', blockers });
      // Neither the position nor the status may move for a driver we refused.
      expect(geo.recordLocation).not.toHaveBeenCalled();
      expect(prisma.driverAvailability.update).not.toHaveBeenCalled();
      expect(index.upsert).not.toHaveBeenCalled();
    });

    it('puts an eligible driver online, position before status', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue(snapshotRow());
      prisma.driverAvailability.update.mockResolvedValue(
        availabilityRow({ status: 'online', vehicleId: VEHICLE_ID, wentOnlineAt: new Date() }),
      );

      const availability = await service.goOnline(DRIVER_ID, { location: TORONTO });

      expect(availability.status).toBe('online');
      expect(availability.isOnline).toBe(true);
      expect(availability.vehicleId).toBe(VEHICLE_ID);
      expect(prisma.driverAvailability.update).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID },
        data: { status: 'online', vehicleId: VEHICLE_ID, wentOnlineAt: expect.any(Date) },
      });
      // A driver must never join the dispatch pool at last night's parking spot,
      // so the ping has to land before the status flips.
      expect(geo.recordLocation.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.driverAvailability.update.mock.invocationCallOrder[0],
      );
      // The live index only hears `online` once the row says so: it is what
      // dispatch searches, and a status written after the commit is one an
      // older reconcile can no longer undo.
      expect(index.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          driverId: DRIVER_ID,
          lat: TORONTO.lat,
          lng: TORONTO.lng,
          status: 'online',
          rideId: null,
        }),
      );
      expect(index.upsert.mock.invocationCallOrder[0]).toBeGreaterThan(
        prisma.driverAvailability.update.mock.invocationCallOrder[0],
      );
    });

    it('still puts the driver online when the live index write fails', async () => {
      // Postgres has committed and the flush worker reconciles the index from
      // it; a Redis blip must not turn a successful go-online into an error.
      prisma.driverProfile.findUnique.mockResolvedValue(snapshotRow());
      prisma.driverAvailability.update.mockResolvedValue(
        availabilityRow({ status: 'online', vehicleId: VEHICLE_ID, wentOnlineAt: new Date() }),
      );
      index.upsert.mockRejectedValue(new Error('redis is down'));

      await expect(service.goOnline(DRIVER_ID, { location: TORONTO })).resolves.toMatchObject({
        status: 'online',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  describe('submit', () => {
    it('refuses while documents are missing and names every one of them', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue(
        snapshotRow({
          kycStatus: 'documents_pending',
          submittedAt: null,
          approvedAt: null,
          documents: [
            documentRow('drivers_license_front', { status: 'pending' }),
            documentRow('profile_photo', { status: 'pending' }),
          ],
        }),
      );

      const error = await refusal(() => service.submit(DRIVER_ID));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.getResponse()).toMatchObject({
        code: 'driver_application_incomplete',
        // Contract order, so the app can render them as a checklist.
        missingDocuments: ['drivers_license_back', 'vehicle_registration', 'insurance'],
        details: [
          'Upload your driver licence (back), vehicle registration and insurance certificate.',
        ],
      });
      expect(prisma.driverProfile.update).not.toHaveBeenCalled();
    });

    it('names the missing vehicle alongside the missing documents', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue(
        snapshotRow({
          kycStatus: 'documents_pending',
          submittedAt: null,
          approvedAt: null,
          documents: [],
          vehicles: [],
        }),
      );

      const error = await refusal(() => service.submit(DRIVER_ID));

      expect(error.getResponse()).toMatchObject({
        details: expect.arrayContaining(['Register the vehicle you drive.']),
      });
    });

    it('accepts an application whose documents are present but not yet approved', async () => {
      // The submit gate asks whether the documents EXIST — approving them is the
      // reviewer's job, and demanding it here would deadlock every application.
      const uploaded = REQUIRED_DRIVER_DOCUMENTS.map((type) =>
        documentRow(type, { status: 'pending', reviewedAt: null }),
      );
      prisma.driverProfile.findUnique
        .mockResolvedValueOnce(
          snapshotRow({
            kycStatus: 'documents_pending',
            submittedAt: null,
            approvedAt: null,
            documents: uploaded,
          }),
        )
        .mockResolvedValueOnce(
          snapshotRow({ kycStatus: 'under_review', approvedAt: null, documents: uploaded }),
        );
      prisma.driverProfile.update.mockResolvedValue(profileRow({ kycStatus: 'under_review' }));

      const me = await service.submit(DRIVER_ID);

      expect(prisma.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: DRIVER_ID },
        data: {
          kycStatus: 'under_review',
          submittedAt: expect.any(Date),
          // A stale reason would still be rendering in the driver app beside an
          // application they have since replaced.
          rejectionReason: null,
        },
      });
      expect(me.profile.kycStatus).toBe('under_review');
    });

    it('refuses an application that is not awaiting documents', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue(snapshotRow({ kycStatus: 'under_review' }));

      const error = await refusal(() => service.submit(DRIVER_ID));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'driver_not_submittable' });
      expect(prisma.driverProfile.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  describe('goOffline', () => {
    it('refuses while the driver is on a trip', async () => {
      prisma.driverAvailability.findUnique.mockResolvedValue(
        availabilityRow({
          status: 'on_trip',
          vehicleId: VEHICLE_ID,
          currentRideId: RIDE_ID,
          wentOnlineAt: aYearAgo(),
        }),
      );

      const error = await refusal(() => service.goOffline(DRIVER_ID));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'driver_on_trip' });
      // Stranding a rider in a car the dispatcher has stopped tracking is the
      // failure this refusal exists to prevent, so nothing may be written.
      expect(prisma.driverAvailability.update).not.toHaveBeenCalled();
      expect(index.remove).not.toHaveBeenCalled();
    });

    it('takes an online driver out of the dispatch pool', async () => {
      prisma.driverAvailability.findUnique.mockResolvedValue(
        availabilityRow({ status: 'online', vehicleId: VEHICLE_ID, wentOnlineAt: aYearAgo() }),
      );
      prisma.driverAvailability.update.mockResolvedValue(
        availabilityRow({ status: 'offline', vehicleId: VEHICLE_ID }),
      );

      const availability = await service.goOffline(DRIVER_ID);

      expect(prisma.driverAvailability.update).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID },
        data: { status: 'offline', wentOnlineAt: null },
      });
      expect(availability.status).toBe('offline');
      expect(availability.isOnline).toBe(false);
      // And off the live map dispatch searches, after the row says so.
      expect(index.remove).toHaveBeenCalledWith(DRIVER_ID);
      expect(index.remove.mock.invocationCallOrder[0]).toBeGreaterThan(
        prisma.driverAvailability.update.mock.invocationCallOrder[0],
      );
    });

    it('is idempotent for a driver who is already offline', async () => {
      // The app fires this on logout and on backgrounding, so the repeat is the
      // normal case rather than the edge one.
      prisma.driverAvailability.findUnique.mockResolvedValue(
        availabilityRow({ status: 'offline' }),
      );

      const availability = await service.goOffline(DRIVER_ID);

      expect(prisma.driverAvailability.update).not.toHaveBeenCalled();
      expect(availability.status).toBe('offline');
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function profileRow(overrides: Partial<DriverProfileRow> = {}): DriverProfileRow {
  return {
    userId: DRIVER_ID,
    kycStatus: 'approved',
    licenceNumber: 'D1234-56789-01234',
    licenceProvince: 'ON',
    licenceExpiresAt: inAYear(),
    ratingSum: 0,
    ratingCount: 0,
    totalRides: 0,
    appliedAt: aYearAgo(),
    submittedAt: aYearAgo(),
    approvedAt: aYearAgo(),
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

/** A driver who clears every rule, so each case only has to break one of them. */
function snapshotRow(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    ...profileRow(),
    vehicles: [vehicleRow()],
    documents: approvedDocuments(),
    availability: availabilityRow(),
    ...overrides,
  };
}

/**
 * Run a call that must be refused and hand the exception back, so each case can
 * assert on the `{ code }` body the driver app switches on rather than only on
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
