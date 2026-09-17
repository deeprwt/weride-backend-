import type { LatLng, RideStatus } from '@uride/types';
import {
  MAX_PLAUSIBLE_SPEED_MPS,
  MIN_ETA_SPEED_MPS,
  SPEED_HISTORY_STALE_MS,
  effectiveSpeedMps,
  estimateLiveEta,
  foldSpeedSample,
  haversineMeters,
  kmhToMps,
  liveTargetFor,
  type LiveEtaModel,
  type SpeedEstimate,
  type TripEndpoints,
} from './live-eta';

/**
 * The live distance and ETA the rider watches, tested on the two things they
 * notice.
 *
 * **The right destination.** Until the trip starts the number is how far the
 * car is from the rider; once it starts, how far the rider is from where they
 * are going. Showing the dropoff distance to someone still on the kerb, or the
 * pickup distance to someone in the back seat, is the kind of wrong nobody
 * forgives.
 *
 * **A believable number at a red light.** A stopped car's running speed decays
 * towards zero, and distance over zero is forever. The floor is what keeps
 * "3 min" from becoming "3 hours" and back again at every light.
 *
 * Pure functions, so no clock, socket or Redis: time is an argument.
 */

const MODEL: LiveEtaModel = { detourFactor: 1.35, citySpeedMps: kmhToMps(28) };

const PICKUP: LatLng = { lat: 43.6532, lng: -79.3832 }; // City Hall
const DROPOFF: LatLng = { lat: 43.7615, lng: -79.4111 }; // North York Centre, ~12 km north
const TRIP: TripEndpoints = { pickup: PICKUP, dropoff: DROPOFF };
/** Where the car is: ~2 km south-east of the pickup, so it is near neither end. */
const CAR: LatLng = { lat: 43.6405, lng: -79.3645 };

const T0 = Date.UTC(2026, 8, 13, 17, 30, 0);

/** Every RideStatus in the contract, so a status added later has to be placed here on purpose. */
const ALL_STATUSES: readonly RideStatus[] = [
  'requested',
  'searching',
  'accepted',
  'driver_arriving',
  'arrived',
  'in_progress',
  'completed',
  'payment_pending',
  'payment_failed',
  'rated_pending',
  'closed',
  'cancelled_by_rider',
  'cancelled_by_driver',
  'no_drivers_found',
];

describe('live ETA', () => {
  // -------------------------------------------------------------------------
  // Target
  // -------------------------------------------------------------------------

  describe('target follows the ride status', () => {
    it.each<[RideStatus, 'pickup' | 'dropoff' | null]>(
      ALL_STATUSES.map((status): [RideStatus, 'pickup' | 'dropoff' | null] => [
        status,
        status === 'accepted' || status === 'driver_arriving' || status === 'arrived'
          ? 'pickup'
          : status === 'in_progress'
            ? 'dropoff'
            : null,
      ]),
    )('%s → %s', (status, target) => {
      expect(liveTargetFor(status)).toBe(target);
      const eta = estimateLiveEta({ driver: CAR, status, trip: TRIP, speed: null, nowMs: T0 }, MODEL);
      if (target === null) expect(eta).toBeNull();
      else expect(eta?.target).toBe(target);
    });

    it('switches from pickup to dropoff at the moment the trip starts — distance and ETA measured to the new end', () => {
      const lifecycle: RideStatus[] = ['accepted', 'driver_arriving', 'arrived', 'in_progress', 'completed'];
      const readings = lifecycle.map((status) =>
        estimateLiveEta({ driver: CAR, status, trip: TRIP, speed: null, nowMs: T0 }, MODEL),
      );

      expect(readings.map((r) => r?.target ?? null)).toEqual(['pickup', 'pickup', 'pickup', 'dropoff', null]);

      const toPickup = Math.round(haversineMeters(CAR, PICKUP) * MODEL.detourFactor);
      const toDropoff = Math.round(haversineMeters(CAR, DROPOFF) * MODEL.detourFactor);
      expect(toDropoff).toBeGreaterThan(toPickup * 3); // the two ends are unmistakable
      expect(readings[2]).toEqual({
        target: 'pickup',
        distanceMeters: toPickup,
        etaSeconds: Math.round(toPickup / MODEL.citySpeedMps),
      });
      expect(readings[3]).toEqual({
        target: 'dropoff',
        distanceMeters: toDropoff,
        etaSeconds: Math.round(toDropoff / MODEL.citySpeedMps),
      });
    });

    it('at the kerb the pickup reads as a few metres, and at trip start the dropoff ETA matches the free quote', () => {
      const atKerb = { lat: PICKUP.lat + 0.00005, lng: PICKUP.lng };
      const arrived = estimateLiveEta({ driver: atKerb, status: 'arrived', trip: TRIP, speed: null, nowMs: T0 }, MODEL);
      expect(arrived?.target).toBe('pickup');
      expect(arrived?.distanceMeters).toBeLessThan(10);

      // RouteEstimatorService with MAPS_PROVIDER=none quotes straight line ×
      // detour at the city speed; the first live ETA from the pickup must agree.
      const started = estimateLiveEta({ driver: PICKUP, status: 'in_progress', trip: TRIP, speed: null, nowMs: T0 }, MODEL);
      const quotedMeters = Math.round(haversineMeters(PICKUP, DROPOFF) * MODEL.detourFactor);
      const quotedSeconds = Math.round((quotedMeters / 1000 / 28) * 3600);
      expect(started?.distanceMeters).toBe(quotedMeters);
      expect(Math.abs((started?.etaSeconds ?? 0) - quotedSeconds)).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Floor
  // -------------------------------------------------------------------------

  describe('the ETA floor holds for a stopped car', () => {
    /** Report `mps` every 4 s for `durationMs`, starting from `from`. */
    function drive(from: SpeedEstimate | null, mps: number, startMs: number, durationMs: number): SpeedEstimate | null {
      let estimate = from;
      for (let at = startMs; at <= startMs + durationMs; at += 4_000) {
        estimate = foldSpeedSample(estimate, mps, at, MODEL);
      }
      return estimate;
    }

    it('ten minutes stationary in traffic never pushes the ETA past distance ÷ half the city speed', () => {
      const cruising = drive(null, 12, T0, 120_000);
      const stuck = drive(cruising, 0, T0 + 124_000, 600_000);
      const nowMs = T0 + 724_000;

      // The running average really has collapsed — this is the case the floor is for.
      expect(stuck?.mps ?? Number.NaN).toBeLessThan(0.1);

      const floor = MODEL.citySpeedMps / 2;
      expect(effectiveSpeedMps(stuck, nowMs, MODEL)).toBeCloseTo(floor, 9);

      const eta = estimateLiveEta({ driver: CAR, status: 'driver_arriving', trip: TRIP, speed: stuck, nowMs }, MODEL);
      const distance = Math.round(haversineMeters(CAR, PICKUP) * MODEL.detourFactor);
      expect(eta?.distanceMeters).toBe(distance);
      expect(eta?.etaSeconds).toBe(Math.round(distance / floor));
      expect(eta?.etaSeconds ?? Number.POSITIVE_INFINITY).toBeLessThan(15 * 60); // not "3 hours"
    });

    it('the floor never drops under 9 km/h, however low the city average is configured', () => {
      const crawlingCity: LiveEtaModel = { detourFactor: 1.35, citySpeedMps: kmhToMps(5) };
      const stopped: SpeedEstimate = { mps: 0, sampledAtMs: T0 };

      expect(effectiveSpeedMps(stopped, T0, crawlingCity)).toBe(MIN_ETA_SPEED_MPS);
      const eta = estimateLiveEta(
        { driver: CAR, status: 'in_progress', trip: TRIP, speed: stopped, nowMs: T0 },
        crawlingCity,
      );
      expect(eta?.etaSeconds).toBe(Math.round((eta?.distanceMeters ?? 0) / MIN_ETA_SPEED_MPS));
    });

    it('a red light dents the estimate instead of zeroing it', () => {
      const cruising = drive(null, 10, T0, 600_000); // long enough to converge on 10 m/s
      expect(cruising?.mps ?? 0).toBeGreaterThan(9.5);
      const afterLight = drive(cruising, 0, T0 + 604_000, 44_000); // 45 s at the light
      expect(afterLight?.mps ?? 0).toBeGreaterThan(5);
      expect(afterLight?.mps ?? 0).toBeLessThan(7);
    });

    it('a car at the kerb shows an ETA of zero, not a negative or a NaN', () => {
      const stopped: SpeedEstimate = { mps: 0, sampledAtMs: T0 };
      const eta = estimateLiveEta({ driver: PICKUP, status: 'arrived', trip: TRIP, speed: stopped, nowMs: T0 }, MODEL);
      expect(eta).toEqual({ target: 'pickup', distanceMeters: 0, etaSeconds: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // The speed estimate the ETA is built on
  // -------------------------------------------------------------------------

  describe('speed estimate', () => {
    it('starts from the city speed: the first sample only starts the clock', () => {
      expect(foldSpeedSample(null, 0, T0, MODEL)).toEqual({ mps: MODEL.citySpeedMps, sampledAtMs: T0 });
    });

    it('ignores GPS glitches, missing speeds and out-of-order samples', () => {
      const estimate: SpeedEstimate = { mps: 8, sampledAtMs: T0 };
      for (const glitch of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_PLAUSIBLE_SPEED_MPS + 0.1, null, undefined]) {
        expect(foldSpeedSample(estimate, glitch, T0 + 4_000, MODEL)).toBe(estimate);
      }
      expect(foldSpeedSample(estimate, 12, T0 - 1_000, MODEL)).toBe(estimate);
      expect(foldSpeedSample(estimate, 12, T0, MODEL)).toBe(estimate);
    });

    it('weights by elapsed time, so a 2 Hz phone and a 4 s phone converge alike', () => {
      let fast: SpeedEstimate | null = { mps: MODEL.citySpeedMps, sampledAtMs: T0 };
      let slow: SpeedEstimate | null = { mps: MODEL.citySpeedMps, sampledAtMs: T0 };
      for (let at = T0 + 500; at <= T0 + 60_000; at += 500) fast = foldSpeedSample(fast, 14, at, MODEL);
      for (let at = T0 + 4_000; at <= T0 + 60_000; at += 4_000) slow = foldSpeedSample(slow, 14, at, MODEL);
      expect(Math.abs((fast?.mps ?? 0) - (slow?.mps ?? 0))).toBeLessThan(1e-9);
    });

    it('forgets history older than two minutes and falls back to the city speed', () => {
      const old: SpeedEstimate = { mps: 20, sampledAtMs: T0 };
      const later = T0 + SPEED_HISTORY_STALE_MS + 1;
      expect(effectiveSpeedMps(old, later, MODEL)).toBe(MODEL.citySpeedMps);
      expect(foldSpeedSample(old, 20, later, MODEL)).toEqual({ mps: MODEL.citySpeedMps, sampledAtMs: later });
    });

    it('never assumes a speed above the plausibility ceiling', () => {
      expect(effectiveSpeedMps({ mps: 55, sampledAtMs: T0 }, T0, MODEL)).toBe(MAX_PLAUSIBLE_SPEED_MPS);
    });
  });
});
