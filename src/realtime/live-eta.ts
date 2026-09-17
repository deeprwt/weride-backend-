import type { LatLng, RideStatus, RtDriverLocationPayload } from '@uride/types';

/**
 * Live distance and ETA from a driver's position to wherever they are heading.
 *
 * Pure arithmetic, run once per ride broadcast — every couple of seconds for
 * every trip in the city. That cadence is the whole reason nothing in this file
 * routes. Google bills per request: a routed ETA every 2 s across 10,000 live
 * trips is 5,000 billable calls a second, an invoice that would outgrow the
 * fares it was decorating. A trip pays for one route, at quote time, through
 * RouteEstimatorService and its cache; everything after that is this file.
 *
 * The model is the one RouteEstimatorService falls back to with
 * MAPS_PROVIDER=none — straight-line distance times ROUTE_DETOUR_FACTOR, at
 * ROUTE_AVERAGE_SPEED_KMH — so with the free provider the first live ETA to the
 * dropoff agrees with the duration the rider was quoted. One refinement: once
 * the driver has reported any speed, the ETA uses THEIR recent average rather
 * than the city's, because the city average knows nothing about the 401 at 3 a.m.
 * or Spadina at 5 p.m.
 *
 * Everything here is a function of its arguments. The gateway owns the state
 * (the running speed estimate per ride) and the clock; this file owns the
 * judgement calls, which is what makes them testable without a socket.
 */

// ---------------------------------------------------------------------------
// Tuning that is not an operator knob
// ---------------------------------------------------------------------------

/**
 * Time constant of the driver's speed average.
 *
 * Long enough to see through a red light — a 45 s stop after cruising at
 * 10 m/s leaves the average near 6 m/s, not zero — and short enough that
 * leaving the highway for side streets shows up within a couple of minutes.
 * Stops are deliberately IN the average: a real trip includes them, and an
 * ETA built only from moving speed is an ETA that is always late.
 */
export const SPEED_SMOOTHING_MS = 90_000;

/**
 * History older than this says nothing about the road ahead — an app that was
 * backgrounded, a tunnel, a phone that stopped reporting speed — so the
 * estimate restarts from the city average instead of trusting it.
 */
export const SPEED_HISTORY_STALE_MS = 120_000;

/**
 * Samples above this (144 km/h) are GPS glitches, not driving: a fix that jumps
 * a block between two readings reports a speed no urban ride reaches. They are
 * dropped rather than clamped, because a clamped glitch still drags the
 * average towards a speed nobody drove.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 40;

/**
 * The ETA never assumes the car is slower than half the city average.
 *
 * This is the floor that stops a car waiting at a long light from showing
 * "ETA: 3 hours". It costs accuracy in genuine gridlock, where the ETA reads
 * optimistic — the better failure of the two: riders anchor on the number
 * they are shown, and one that swings from 6 minutes to 40 and back at every
 * light is read as broken, where one that runs a little long is read as traffic.
 */
export const MIN_SPEED_FRACTION_OF_CITY = 0.5;

/**
 * Absolute floor under that fraction (9 km/h), so a city average configured
 * absurdly low cannot reintroduce the multi-hour ETA the fraction exists to
 * prevent.
 */
export const MIN_ETA_SPEED_MPS = 2.5;

/** Mean Earth radius (IUGG), matching the live driver index's haversine. */
const EARTH_RADIUS_METERS = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the driver is heading. The contract's `target`, minus its null. */
export type LiveTarget = NonNullable<RtDriverLocationPayload['target']>;

/** The two numbers the estimate is built from, both from pricing configuration. */
export interface LiveEtaModel {
  /** Road metres per straight-line metre (ROUTE_DETOUR_FACTOR). */
  detourFactor: number;
  /** Speed assumed until the driver has shown their own, m/s (ROUTE_AVERAGE_SPEED_KMH). */
  citySpeedMps: number;
}

/** The fixed ends of a trip. Only read, never routed. */
export interface TripEndpoints {
  pickup: LatLng;
  dropoff: LatLng;
}

/** A driver's smoothed recent speed on one ride. */
export interface SpeedEstimate {
  mps: number;
  /** Server clock of the last sample folded in. */
  sampledAtMs: number;
}

export interface LiveEta {
  target: LiveTarget;
  /** Estimated road metres, whole. */
  distanceMeters: number;
  /** Whole seconds. */
  etaSeconds: number;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Which end of the trip the driver is driving to, for a ride in this status.
 *
 * `arrived` still targets the pickup: the driver is at the kerb, the distance is
 * a few metres, and "your driver is here" is exactly what the rider should read.
 * Null for anything else, including any status added to ACTIVE_TRIP_STATUSES
 * later — no target is an honest answer, and a guessed one is not.
 */
export function liveTargetFor(status: RideStatus): LiveTarget | null {
  switch (status) {
    case 'accepted':
    case 'driver_arriving':
    case 'arrived':
      return 'pickup';
    case 'in_progress':
      return 'dropoff';
    default:
      return null;
  }
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG_TO_RAD) * Math.cos(b.lat * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function kmhToMps(kmh: number): number {
  return (kmh * 1000) / 3600;
}

/**
 * Fold one reported speed into the driver's running average.
 *
 * A time-weighted exponential average rather than a per-sample one: the driver
 * app emits every 3–5 s but a phone may legitimately send 2 Hz, and a
 * per-sample weight would make the 2 Hz driver's ETA ten times twitchier than
 * everyone else's. Weighting by elapsed time makes the average mean "the last
 * minute and a half" whatever the device's cadence.
 *
 * The average starts at the city speed — that IS the fallback, expressed as a
 * prior — and the driver's samples pull it towards their own. The first sample
 * only starts the clock: with no previous reading there is no interval for it
 * to stand for, and one reading taken at a red light is exactly the sample
 * that should not set anyone's ETA.
 *
 * Unusable samples (absent, negative, non-finite, implausibly fast) and
 * out-of-order ones leave the estimate as it was.
 */
export function foldSpeedSample(
  previous: SpeedEstimate | null,
  sampleMps: number | null | undefined,
  atMs: number,
  model: LiveEtaModel,
): SpeedEstimate | null {
  if (!isPlausibleSpeed(sampleMps)) return previous;

  if (previous === null || atMs - previous.sampledAtMs > SPEED_HISTORY_STALE_MS) {
    return { mps: model.citySpeedMps, sampledAtMs: atMs };
  }
  const elapsedMs = atMs - previous.sampledAtMs;
  if (elapsedMs <= 0) return previous;

  const weight = 1 - Math.exp(-elapsedMs / SPEED_SMOOTHING_MS);
  return {
    mps: previous.mps + weight * (sampleMps - previous.mps),
    sampledAtMs: atMs,
  };
}

/**
 * The speed an ETA is computed at right now: the driver's recent average when
 * it is still recent, the city average otherwise, never under the floor and
 * never over the plausibility ceiling.
 */
export function effectiveSpeedMps(
  estimate: SpeedEstimate | null,
  nowMs: number,
  model: LiveEtaModel,
): number {
  const recent =
    estimate !== null && nowMs - estimate.sampledAtMs <= SPEED_HISTORY_STALE_MS
      ? estimate.mps
      : model.citySpeedMps;
  const floor = Math.max(MIN_ETA_SPEED_MPS, model.citySpeedMps * MIN_SPEED_FRACTION_OF_CITY);
  return Math.min(MAX_PLAUSIBLE_SPEED_MPS, Math.max(floor, recent));
}

/**
 * Distance and ETA from the driver's live position to the target for this
 * status, or null when the status has no target.
 *
 * Distance is straight-line times the detour factor, whole metres: GPS is good
 * to a handful of them, so decimals would be false precision on the rider's
 * screen. Seconds are whole for the same reason.
 */
export function estimateLiveEta(
  input: {
    driver: LatLng;
    status: RideStatus;
    trip: TripEndpoints;
    speed: SpeedEstimate | null;
    nowMs: number;
  },
  model: LiveEtaModel,
): LiveEta | null {
  const target = liveTargetFor(input.status);
  if (target === null) return null;

  const destination = target === 'pickup' ? input.trip.pickup : input.trip.dropoff;
  const distanceMeters = Math.round(haversineMeters(input.driver, destination) * model.detourFactor);
  const speedMps = effectiveSpeedMps(input.speed, input.nowMs, model);

  return { target, distanceMeters, etaSeconds: Math.round(distanceMeters / speedMps) };
}

function isPlausibleSpeed(value: number | null | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PLAUSIBLE_SPEED_MPS
  );
}
