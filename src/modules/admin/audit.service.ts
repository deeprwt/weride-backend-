import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.module';

/**
 * Detail bag attached to an audit row. Typed as Prisma's JSON input rather than
 * `Record<string, unknown>` so a value that cannot survive a round trip through
 * JSONB — a Date, a Map, a class instance — is rejected at compile time instead
 * of landing in the column as `{}`.
 */
export type AuditMetadata = Prisma.InputJsonObject;

export interface AuditEntry {
  /** `users.id` of whoever took the action. Never a service account in Phase 2. */
  actorId: string;
  /** The role the action was taken UNDER, not every role the actor holds. */
  actorRole: string | null;
  /** Dot-namespaced past-tense verb, e.g. `driver.approved`. */
  action: string;
  /** Table-ish noun the action applied to, e.g. `driver_profile`. */
  resource: string;
  resourceId?: string | null;
  metadata?: AuditMetadata;
}

/**
 * Most privileged first. An ops lead who also holds `support` acted as ops, and
 * that is the role a later reviewer needs to see against the decision.
 */
const ROLE_PRECEDENCE: readonly string[] = ['admin', 'ops', 'support', 'driver', 'rider'];

/**
 * Collapse a principal's role list to the single role an action was taken
 * under. `audit_logs.actor_role` is one column by design: a regulator asks
 * "under what authority was this driver suspended", not "what could this person
 * have done".
 */
export function primaryRole(roles: readonly string[]): string | null {
  for (const role of ROLE_PRECEDENCE) {
    if (roles.includes(role)) return role;
  }
  return roles[0] ?? null;
}

/**
 * AuditService — the compliance trail behind every privileged action.
 *
 * This is a legal obligation, not an observability nicety. A KYC decision
 * governs whether a person may earn a living, and both PIPEDA and the
 * provincial rideshare regimes expect the operator to answer, months later, who
 * approved or suspended a given driver and on what grounds. Application logs
 * cannot carry that: they roll out of retention, they are not queryable per
 * driver, and a log-shipping outage loses them silently. `audit_logs` is a
 * durable table joined to the actor by foreign key.
 *
 * The `client` parameter is what makes the guarantee real. Callers pass the
 * transaction that performs the change, so the decision and its audit row
 * commit together or not at all — a row written afterwards would let a crash in
 * between leave a suspended driver with no record of who suspended them, which
 * is exactly the state we would have to explain to a tribunal.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one audit row.
   *
   * Deliberately not fail-safe: a failure here propagates and rolls the caller's
   * transaction back. An unrecorded privileged action is worse than a failed
   * one, because only the failure is recoverable — the operator can retry.
   */
  async record(entry: AuditEntry, client: Prisma.TransactionClient = this.prisma): Promise<void> {
    await client.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata,
      },
    });
    this.logger.debug(
      `audit ${entry.action} resource=${entry.resource}:${entry.resourceId ?? '-'} ` +
        `actor=${entry.actorId} role=${entry.actorRole ?? '-'}`,
    );
  }
}
