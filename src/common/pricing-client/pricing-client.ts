import { Injectable, Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import type { QuoteRequestInput } from '@uride/validation';
import type { Cents, FareQuote, RideClass } from '@uride/types';
import { loadEnv } from '../../config/env';

// Keep these in lock-step with pricing/app/fares.py — used only by the breaker
// fallback when the pricing service is unavailable.
const FALLBACK_TARIFF = {
  baseFareCents: 250,
  perKmCents: 120,
  perMinCents: 30,
  minFareCents: 600,
  bookingFeeCents: 99,
  avgSpeedKmh: 28,
  // fares.py SURGE_FLOOR / SURGE_CEILING. The service clamps whatever it is
  // sent, so the fallback clamps too — otherwise a degraded quote could apply a
  // multiplier the service would have refused.
  surgeFloor: 1,
  surgeCeiling: 3,
  classMultiplier: { standard: 1, xl: 1.5, premium: 2 } as Record<RideClass, number>,
};

const EARTH_RADIUS_M = 6_371_000;

// fares.py uses math.radians, which is x * (pi / 180). Written the same way
// rather than (x * pi) / 180, which can differ in the last bit.
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in metres. Mirrors fares.py haversine_meters, and is
 * exported so the route estimator's straight-line fallback measures a trip the
 * same way the fare fallback does.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dPhi = (b.lat - a.lat) * DEG_TO_RAD;
  const dLmb = (b.lng - a.lng) * DEG_TO_RAD;
  const s =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(a.lat * DEG_TO_RAD) * Math.cos(b.lat * DEG_TO_RAD) * Math.sin(dLmb / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/**
 * What the core API measured about a trip that the pricing service cannot:
 * the zone's surge multiplier (SurgeService) and the road distance and duration
 * (RouteEstimatorService).
 *
 * Every field is optional, and an absent one means the service's legacy
 * behaviour — straight-line distance, flat average speed, no surge.
 *
 * A separate argument from the rider's QuoteRequestInput on purpose. That
 * object is client input; these are server measurements. Keeping them apart
 * means no controller can ever forward a client-supplied surge multiplier by
 * spreading a request body into a quote.
 */
export interface PricingInputs {
  surgeMultiplier?: number;
  distanceMeters?: number;
  durationSeconds?: number;
}

/** Exactly what goes on the wire to POST /v1/quote. */
interface QuoteCall {
  pickup: QuoteRequestInput['pickup'];
  dropoff: QuoteRequestInput['dropoff'];
  rideClass: RideClass;
  surgeMultiplier?: number;
  distanceMeters?: number;
  durationSeconds?: number;
}

/**
 * PricingClient — typed adapter for the FastAPI pricing service.
 *
 * Wrapped in opossum so a degraded pricing service can't take the core API
 * down: after N failures the breaker opens and we quote locally with the same
 * tariff, so a rider can still book.
 */
@Injectable()
export class PricingClient {
  private readonly logger = new Logger(PricingClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly healthBreaker: CircuitBreaker<[], { status: string }>;
  private readonly quoteBreaker: CircuitBreaker<[QuoteCall], FareQuote>;

  constructor() {
    const env = loadEnv();
    this.baseUrl = env.PRICING_BASE_URL;
    this.timeoutMs = env.PRICING_TIMEOUT_MS;

    this.healthBreaker = new CircuitBreaker(this.callHealth.bind(this), {
      timeout: this.timeoutMs,
      errorThresholdPercentage: 50,
      resetTimeout: 10_000,
    });
    this.healthBreaker.on('open', () =>
      this.logger.warn(`PricingClient circuit OPEN — ${this.baseUrl} unavailable`),
    );
    this.healthBreaker.on('halfOpen', () => this.logger.log('PricingClient circuit half-open'));
    this.healthBreaker.on('close', () => this.logger.log('PricingClient circuit CLOSED'));
    this.healthBreaker.fallback(() => ({ status: 'unavailable' }));

    this.quoteBreaker = new CircuitBreaker(this.callQuote.bind(this), {
      timeout: this.timeoutMs,
      errorThresholdPercentage: 50,
      resetTimeout: 10_000,
    });
    // Degraded mode: quote locally so a rider can still book if pricing is down.
    this.quoteBreaker.fallback((call: QuoteCall) => {
      this.logger.warn('PricingClient quote fallback — estimating fare locally');
      return localQuote(call);
    });
  }

  async health(): Promise<{ status: string }> {
    return this.healthBreaker.fire();
  }

  /**
   * Authoritative fare estimate from the pricing service (local fallback on
   * outage). Pass the surge and route measurements in `inputs`; without them
   * the quote is straight-line with no surge, as it always was.
   */
  async quote(input: QuoteRequestInput, inputs: PricingInputs = {}): Promise<FareQuote> {
    return this.quoteBreaker.fire(buildQuoteCall(input, inputs));
  }

  private async callHealth(): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`pricing /healthz ${res.status}`);
    return (await res.json()) as { status: string };
  }

  private async callQuote(call: QuoteCall): Promise<FareQuote> {
    const res = await fetch(`${this.baseUrl}/v1/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`pricing /v1/quote ${res.status}`);
    return (await res.json()) as FareQuote;
  }
}

/**
 * Build the request body field by field. Nothing from the caller's object is
 * spread in, so an extra property on a request body can never reach the
 * pricing service.
 *
 * Measurements that are not usable numbers are dropped here, before the service
 * or the fallback sees them, and both then treat the field as absent. Doing it
 * once, upstream of the breaker, is what keeps the two paths agreeing: sent as
 * is, NaN serialises to null (absent, to the service) while the fallback would
 * have multiplied by it, and a negative distance is a 422 from the service —
 * which the breaker counts as a failure and answers with a local quote anyway.
 */
function buildQuoteCall(input: QuoteRequestInput, inputs: PricingInputs): QuoteCall {
  const call: QuoteCall = {
    pickup: { lat: input.pickup.lat, lng: input.pickup.lng },
    dropoff: { lat: input.dropoff.lat, lng: input.dropoff.lng },
    rideClass: input.rideClass ?? 'standard',
  };
  if (isFiniteNumber(inputs.surgeMultiplier)) call.surgeMultiplier = inputs.surgeMultiplier;
  if (isFiniteNumber(inputs.distanceMeters) && inputs.distanceMeters >= 0) {
    call.distanceMeters = inputs.distanceMeters;
  }
  if (isFiniteNumber(inputs.durationSeconds) && inputs.durationSeconds >= 0) {
    call.durationSeconds = inputs.durationSeconds;
  }
  return call;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** fares.py applied_surge: clamp, then round to one decimal, ties up. */
function appliedSurge(requested: number | undefined): number {
  const t = FALLBACK_TARIFF;
  const raw = requested ?? 1;
  const clamped = Math.min(Math.max(raw, t.surgeFloor), t.surgeCeiling);
  return Math.round(clamped * 10) / 10;
}

/**
 * Deterministic local estimate — fares.py quote_fare, line for line.
 *
 * Same order of operations and the same rounding at every step (Math.round,
 * which fares.py reproduces as round_half_up). When the route inputs are
 * present every value here is an integer carried through IEEE-754 doubles,
 * which JavaScript and Python compute identically, so the two quote the same
 * cents. Without them, distance comes from haversine, whose trig functions can
 * differ between runtimes in the last bit — enough to matter only for a trip
 * whose straight-line length lands within a nanometre of a half metre.
 *
 * If fares.py changes, this changes in the same commit. A fallback that quotes
 * differently from the service charges riders two prices for one trip.
 */
function localQuote(call: QuoteCall): FareQuote {
  const t = FALLBACK_TARIFF;
  const rideClass: RideClass = Object.hasOwn(t.classMultiplier, call.rideClass)
    ? call.rideClass
    : 'standard';
  const classMult = t.classMultiplier[rideClass];
  const surge = appliedSurge(call.surgeMultiplier);

  const distanceMeters =
    call.distanceMeters !== undefined
      ? Math.round(call.distanceMeters)
      : Math.round(haversineMeters(call.pickup, call.dropoff));
  const durationSeconds =
    call.durationSeconds !== undefined
      ? Math.round(call.durationSeconds)
      : Math.round((distanceMeters / 1000 / t.avgSpeedKmh) * 3600);

  const distanceCents = Math.round((t.perKmCents * distanceMeters) / 1000);
  const timeCents = Math.round((t.perMinCents * durationSeconds) / 60);
  const subtotal = (t.baseFareCents + distanceCents + timeCents) * classMult * surge;
  const fareCents = Math.max(Math.round(subtotal) + t.bookingFeeCents, t.minFareCents);

  return {
    currency: 'CAD',
    rideClass,
    distanceMeters,
    durationSeconds,
    fareCents: fareCents as Cents,
    surgeMultiplier: surge,
    breakdown: {
      baseFareCents: t.baseFareCents as Cents,
      distanceCents: distanceCents as Cents,
      timeCents: timeCents as Cents,
      bookingFeeCents: t.bookingFeeCents as Cents,
      classMultiplier: classMult,
      surgeMultiplier: surge,
    },
  };
}
