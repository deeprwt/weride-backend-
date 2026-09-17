import type { Logger } from '@nestjs/common';
import type { DefaultEventsMap, ExtendedError, Namespace, Socket } from 'socket.io';
import type {
  RideOfferForDriver,
  RideSummary,
  RtDriverLocationPayload,
  RtErrorPayload,
  RtOfferRevokedPayload,
} from '@uride/types';
import type { RequestPrincipal } from '../common/auth/current-user.decorator';
import type { IdentityProvider } from '../common/identity/identity-provider.interface';
import type { SessionService } from '../common/session/session.service';

/**
 * Socket authentication, and the types every other file in this module speaks.
 *
 * A socket is a long-lived authenticated session and the one entry point into
 * the platform that does not pass through JwtAuthGuard. Everything that makes
 * the REST guard trustworthy therefore has to be reproduced here — the same
 * IdentityProvider, the same denylist lookup, the same principal shape —
 * because a second, subtly weaker way to prove who you are is how a platform
 * ends up with one door that checks tokens and one that does not.
 */

/** The role allowed to stream positions and receive offers. Matches `UserRole`. */
const DRIVER_ROLE = 'driver';

/** Accepts `Bearer xyz` as well as a bare token, in either carrier. */
const BEARER_PREFIX = /^bearer\s+/i;

// ---------------------------------------------------------------------------
// Typed event maps
// ---------------------------------------------------------------------------

/**
 * Server → client events, keyed by the wire names in RT_SERVER_EVENTS.
 *
 * Everything outbound goes through this map, so a payload that drifts from the
 * shared contract is a compile error rather than a client that silently renders
 * nothing. Emit sites always spell the event with the RT_SERVER_EVENTS
 * constant, which is what keeps these keys honest: change one side and the
 * other stops compiling.
 */
export interface RtServerToClientEvents {
  'ride:status': (payload: RideSummary) => void;
  'ride:driver_location': (payload: RtDriverLocationPayload) => void;
  'offer:new': (payload: RideOfferForDriver) => void;
  'offer:revoked': (payload: RtOfferRevokedPayload) => void;
  'rt:error': (payload: RtErrorPayload) => void;
}

/**
 * Client → server events, keyed by RT_CLIENT_EVENTS.
 *
 * Every payload is `unknown` on purpose. These frames are attacker-controlled
 * and arrive with no framework pipe in front of them; the only thing allowed to
 * narrow one is a zod schema from @uride/validation, inside the handler.
 */
export interface RtClientToServerEvents {
  'ride:subscribe': (payload: unknown) => void;
  'ride:unsubscribe': (payload: unknown) => void;
  'driver:location': (payload: unknown) => void;
}

export type RtSocket = Socket<
  RtClientToServerEvents,
  RtServerToClientEvents,
  DefaultEventsMap,
  RtSocketData
>;

/**
 * What a namespaced gateway actually holds: Nest's IoAdapter returns
 * `io.of('/rt')`, so the object handed to `afterInit` is a Namespace, not the
 * root Server. Typing it honestly is what lets `.use()` and `.to().emit()` be
 * checked against the maps above.
 */
export type RtNamespace = Namespace<
  RtClientToServerEvents,
  RtServerToClientEvents,
  DefaultEventsMap,
  RtSocketData
>;

// ---------------------------------------------------------------------------
// Per-socket server-side state
// ---------------------------------------------------------------------------

/** Token bucket behind the inbound location limiter. Filled in by the gateway. */
export interface LocationBudget {
  tokens: number;
  lastRefillMs: number;
  /** Throttles the reply, so a flood cannot make the server flood back. */
  lastWarnedMs: number;
}

/**
 * State socket.io carries for us on `socket.data`.
 *
 * `principal` is the same object JwtAuthGuard puts on `req.user`, deliberately:
 * code that needs to know who is calling reads one shape whether it was reached
 * over HTTP or over the socket.
 */
export interface RtSocketData {
  principal: RequestPrincipal;
  /** Cached off the principal's roles — consulted on every location frame. */
  isDriver: boolean;
  /** Created lazily by the gateway on the first location frame. */
  locationBudget?: LocationBudget;
  /** Disconnects the socket when its access token expires. */
  expiryTimer?: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Room names are minted here, beside the authentication that grants them,
 * because in this module a room *is* an authorisation decision: membership of
 * `ride:<id>` is the entire reason a rider is allowed to see a driver moving.
 * One spelling in one place, so the publisher and the joiner cannot disagree.
 */
export const rideRoom = (rideId: string): string => `ride:${rideId}`;
export const driverRoom = (driverId: string): string => `driver:${driverId}`;

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface RtAuthDeps {
  identity: IdentityProvider;
  sessions: SessionService;
  logger: Logger;
}

/**
 * Pull the access token off the handshake.
 *
 * Two carriers, both first-class: `auth.token` (what socket.io clients set, and
 * the only option a browser has — a WS upgrade cannot carry custom headers) and
 * the standard `Authorization` header (native clients, load generators, curl).
 *
 * A `?token=` query parameter is deliberately NOT accepted, despite the Phase 0
 * note in docs/API.md suggesting it: query strings are copied verbatim into
 * proxy access logs, browser history and error trackers, and socket.io's `auth`
 * payload removes the browser limitation that made the query string tempting.
 */
export function extractSocketToken(handshake: RtSocket['handshake']): string | null {
  const fromAuth = readString(handshake.auth, 'token');
  if (fromAuth) return stripBearer(fromAuth);

  const header = handshake.headers.authorization;
  if (typeof header === 'string' && BEARER_PREFIX.test(header)) return stripBearer(header);

  return null;
}

/** Milliseconds until the principal's access token expires; negative once past. */
export const msUntilExpiry = (principal: RequestPrincipal): number =>
  principal.exp * 1000 - Date.now();

/**
 * Namespace middleware that authenticates every socket before it connects.
 *
 * Rejecting here rather than inside `handleConnection` is what makes the gate
 * airtight: a socket refused by middleware never finishes its handshake, so it
 * never joins a room, never reaches a message handler and never shows up in
 * `namespace.sockets`. The client receives `connect_error` carrying
 * `{ code, message }` — the same body shape the REST API returns — and so knows
 * to refresh its token instead of reconnecting forever with a dead one.
 */
export function createRtAuthMiddleware(
  deps: RtAuthDeps,
): (socket: RtSocket, next: (err?: ExtendedError) => void) => Promise<void> {
  return async (socket: RtSocket, next: (err?: ExtendedError) => void): Promise<void> => {
    const token = extractSocketToken(socket.handshake);
    if (!token) {
      next(handshakeError('auth_required', 'A valid access token is required to connect.'));
      return;
    }

    try {
      const principal = await deps.identity.verifyAccessToken(token);

      // The same denylist the REST guard consults. Logout and family revocation
      // have to close live sockets too — otherwise signing out of a stolen
      // session leaves the thief's socket streaming happily until its token
      // expires.
      if (await deps.sessions.isAccessJtiDenied(principal.jti)) {
        next(handshakeError('token_revoked', 'This session has been signed out.'));
        return;
      }

      socket.data = { principal, isDriver: principal.roles.includes(DRIVER_ROLE) };
      next();
    } catch (error) {
      // The verifier's message ("signature mismatch", "jwt expired") is useful
      // to us and free reconnaissance for whoever is probing the handshake, so
      // it goes to the log and a flat refusal goes to the client.
      const detail = error instanceof Error ? error.message : 'token verification failed';
      deps.logger.debug(`Rejected socket ${socket.id}: ${detail}`);
      next(handshakeError('auth_invalid', 'Your session is no longer valid. Sign in again.'));
    }
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * socket.io hands a middleware error's `message` and `data` to the client's
 * `connect_error` listener; `data` is where the machine-readable code rides, so
 * the apps can branch on it exactly as they branch on a REST `code`.
 */
function handshakeError(code: string, message: string): ExtendedError {
  const error = new Error(message) as ExtendedError;
  const payload: RtErrorPayload = { code, message };
  error.data = payload;
  return error;
}

function stripBearer(raw: string): string | null {
  const token = raw.replace(BEARER_PREFIX, '').trim();
  return token.length > 0 ? token : null;
}

/** Reads one string property off the untyped handshake bag, or null. */
function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
