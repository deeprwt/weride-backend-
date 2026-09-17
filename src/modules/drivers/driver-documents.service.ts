import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import type { DriverDocument as DriverDocumentRow, Prisma } from '@prisma/client';
import {
  EXPIRING_DRIVER_DOCUMENTS,
  type DriverDocument,
  type DriverDocumentStatus,
  type DriverDocumentType,
  type DriverId,
  type ISODateTime,
  type UUID,
} from '@uride/types';
import type { DocumentUploadMetaInput } from '@uride/validation';
import { PrismaService } from '../../common/prisma/prisma.module';
import { DocumentStorage } from '../../common/storage/document-storage.interface';

/**
 * The slice of multer's in-memory file this module actually consumes.
 *
 * Declared here rather than pulling in @types/multer: backend/tsconfig.json pins
 * `types` to node + jest, so the global `Express.Multer` namespace that package
 * augments would not be picked up anyway, and these four fields are the entire
 * contract between the interceptor and DocumentStorage.
 */
export interface UploadedDocumentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Document names as they read inside a sentence. They are interpolated into the
 * blocker strings the driver app renders as a checklist, so they are phrased
 * mid-sentence ("Upload your insurance certificate.") rather than as headings.
 */
export const DRIVER_DOCUMENT_LABELS: Record<DriverDocumentType, string> = {
  drivers_license_front: 'driver licence (front)',
  drivers_license_back: 'driver licence (back)',
  vehicle_registration: 'vehicle registration',
  insurance: 'insurance certificate',
  profile_photo: 'profile photo',
  background_check: 'background check',
};

/** Self-service download route. 'v1' is the global prefix set in main.ts. */
const SELF_DOCUMENT_PATH = '/v1/drivers/me/documents';

/**
 * DriverDocumentsService — KYC uploads: store the bytes, own the row, and serve
 * the file back to the one person entitled to it.
 *
 * The bytes and the row live in different systems and cannot be written
 * atomically, so the ordering is deliberate throughout: bytes land first, the
 * row is swapped in a transaction, and only then is the superseded blob removed.
 * Every failure therefore leaves an unreferenced file (cheap, sweepable) rather
 * than a document row pointing at bytes that are gone — which a reviewer would
 * meet as a 404 halfway through an approval.
 */
@Injectable()
export class DriverDocumentsService {
  private readonly logger = new Logger(DriverDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
  ) {}

  /**
   * Store one document, replacing any previous upload of the same type.
   *
   * There is a unique index on (driver_id, type), so a re-upload is a swap and
   * not an append: the driver sees one row per document, and a reviewer is never
   * shown a stale copy alongside the current one.
   */
  async upload(
    driverId: string,
    meta: DocumentUploadMetaInput,
    file: UploadedDocumentFile | undefined,
  ): Promise<DriverDocument> {
    if (!file) {
      throw new BadRequestException({
        code: 'document_file_required',
        message: 'Attach the document as the `file` part of a multipart/form-data request.',
      });
    }

    // The contract excludes background checks from the driver's own uploads:
    // they are ordered and filed by ops, and a driver who could supply their own
    // would be vouching for themselves.
    if (meta.type === 'background_check') {
      throw new ForbiddenException({
        code: 'document_type_not_uploadable',
        message: 'Background checks are filed by WeRide operations, not by the driver.',
      });
    }

    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: driverId },
      select: { kycStatus: true },
    });
    if (!profile) {
      throw new NotFoundException({
        code: 'driver_profile_not_found',
        message: 'Apply to drive before uploading documents.',
      });
    }

    const expiresAt = resolveExpiry(meta);

    // Size, allow-list, magic bytes and hashing all happen inside put(), so a
    // file that fails any of them never reaches the database.
    const stored = await this.storage.put({
      bytes: file.buffer,
      fileName: file.originalname,
      declaredMimeType: file.mimetype,
    });

    let result: { row: DriverDocumentRow; supersededKey: string | null };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const previous = await tx.driverDocument.findUnique({
          where: { driverId_type: { driverId, type: meta.type } },
          select: { storageKey: true },
        });

        const row = await tx.driverDocument.upsert({
          where: { driverId_type: { driverId, type: meta.type } },
          create: {
            driverId,
            type: meta.type,
            storageKey: stored.storageKey,
            fileName: file.originalname,
            // The sniffed type, never the declared one: persisting what the
            // client claimed would hand it a Content-Type header of its own
            // choosing on the way back out.
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            contentSha256: stored.contentSha256,
            expiresAt,
          },
          update: {
            storageKey: stored.storageKey,
            fileName: file.originalname,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            contentSha256: stored.contentSha256,
            expiresAt,
            // A replacement is unreviewed by definition, so the previous
            // decision and its reviewer are cleared rather than inherited.
            status: 'pending',
            rejectionReason: null,
            reviewedById: null,
            reviewedAt: null,
            uploadedAt: new Date(),
          },
        });

        await this.reopenKyc(tx, driverId, profile.kycStatus);
        return { row, supersededKey: previous?.storageKey ?? null };
      });
    } catch (error) {
      // The row never landed, so nothing references these bytes. Drop them
      // rather than leave an unowned KYC scan sitting in the store.
      await this.storage.delete(stored.storageKey).catch((err: unknown) => {
        this.logger.error(
          `Orphaned ${stored.storageKey} after a failed upload: ${describe(err)}`,
        );
      });
      throw error;
    }

    const supersededKey = result.supersededKey;
    if (supersededKey) {
      // Best effort, and only after the commit. A blob we fail to delete costs
      // disk; deleting it before the swap committed would cost the driver the
      // document they still have on file.
      await this.storage.delete(supersededKey).catch((err: unknown) => {
        this.logger.error(`Could not delete superseded ${supersededKey}: ${describe(err)}`);
      });
    }

    this.logger.log(`Driver ${driverId} uploaded a ${DRIVER_DOCUMENT_LABELS[meta.type]}.`);
    return toDriverDocument(result.row);
  }

  /** Every document on file for this driver, newest upload first. */
  async list(driverId: string): Promise<DriverDocument[]> {
    const rows = await this.prisma.driverDocument.findMany({
      where: { driverId },
      orderBy: { uploadedAt: 'desc' },
    });
    return rows.map(toDriverDocument);
  }

  /**
   * Stream one document back to its owner.
   *
   * The ownership check is enforced here and not left to the RLS policy on
   * driver_documents: the API connects to Postgres as the table owner, which
   * bypasses RLS entirely (the same reason RidesService re-checks ride
   * ownership). Without this comparison any signed-in account could read any
   * driver's licence scan by guessing an id.
   */
  async openForDownload(driverId: string, documentId: string): Promise<StreamableFile> {
    const row = await this.prisma.driverDocument.findUnique({ where: { id: documentId } });
    if (!row) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Document not found.',
      });
    }
    if (row.driverId !== driverId) {
      throw new ForbiddenException({
        code: 'not_your_document',
        message: 'Not your document.',
      });
    }

    const stream = await this.storage.getStream(row.storageKey);
    return new StreamableFile(stream, {
      type: row.mimeType,
      // attachment, never inline. These files are served from the API's own
      // origin, and anything the browser renders in place runs against that
      // origin — the magic-byte check proves the file is a PDF, not that its
      // contents are harmless.
      disposition: `attachment; filename="${safeFileName(row.fileName)}"`,
      length: row.sizeBytes,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Move the profile back into the review queue when a replacement lands.
   *
   * An approval is an approval of the exact documents a human looked at.
   * Swapping the insurance scan afterwards is precisely how a driver would keep
   * their approval while driving on a policy nobody has seen, so an approved
   * profile returns to `under_review` and its driver comes off the road until it
   * clears. A driver mid-trip is left alone: there is a passenger in the car.
   */
  private async reopenKyc(
    tx: Prisma.TransactionClient,
    driverId: string,
    kycStatus: string,
  ): Promise<void> {
    if (kycStatus === 'approved') {
      await tx.driverProfile.update({
        where: { userId: driverId },
        // submitted_at is what the KYC queue orders by, so it is reset: this
        // application re-enters the queue now, not at its original place in it.
        data: { kycStatus: 'under_review', submittedAt: new Date() },
      });
      const { count } = await tx.driverAvailability.updateMany({
        where: { driverId, status: 'online' },
        data: { status: 'offline', wentOnlineAt: null },
      });
      if (count > 0) {
        this.logger.warn(
          `Driver ${driverId} taken offline: a replaced document sent their KYC back to review.`,
        );
      }
      return;
    }

    // A rejected applicant who uploads the fix has to be able to submit again;
    // leaving them 'rejected' would be a dead end with no route back into the
    // queue.
    if (kycStatus === 'rejected') {
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: { kycStatus: 'documents_pending', rejectionReason: null, submittedAt: null },
      });
    }
  }
}

/**
 * Decide the expiry a document is filed under.
 *
 * A licence, an insurance certificate and a registration are only as good as
 * their expiry date, so it is mandatory for those types and must still be in the
 * future — an already-lapsed upload would be queued, reviewed, approved, and
 * then block the driver at go-online time anyway. Types with no meaningful
 * expiry store null even when the client sends one.
 */
function resolveExpiry(meta: DocumentUploadMetaInput): Date | null {
  if (!EXPIRING_DRIVER_DOCUMENTS.includes(meta.type)) return null;

  const label = DRIVER_DOCUMENT_LABELS[meta.type];
  if (!meta.expiresAt) {
    throw new BadRequestException({
      code: 'document_expiry_required',
      message: `Tell us when this ${label} expires.`,
    });
  }

  const expiresAt = new Date(meta.expiresAt);
  if (expiresAt.getTime() <= Date.now()) {
    throw new BadRequestException({
      code: 'document_expired',
      message: `That ${label} expired on ${asDay(expiresAt)}. Upload a current one.`,
    });
  }
  return expiresAt;
}

/** Map a document row to its wire shape: ISO timestamps, no storage key. */
export function toDriverDocument(row: DriverDocumentRow): DriverDocument {
  return {
    id: row.id as UUID,
    driverId: row.driverId as DriverId,
    type: row.type as DriverDocumentType,
    status: row.status as DriverDocumentStatus,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    // storage_key stays server-side: it is the one value that, once leaked,
    // fetches the bytes without passing this module's ownership check.
    downloadPath: `${SELF_DOCUMENT_PATH}/${row.id}/file`,
    expiresAt: isoOrNull(row.expiresAt),
    rejectionReason: row.rejectionReason,
    reviewedAt: isoOrNull(row.reviewedAt),
    uploadedAt: row.uploadedAt.toISOString() as ISODateTime,
  };
}

/**
 * The filename is client-supplied and goes straight into a Content-Disposition
 * header, where a quote or a newline would let the caller append headers of
 * their own. Reduce it to a character set that cannot mean anything else.
 */
function safeFileName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'document';
}

/** ISO calendar day — dates in driver-facing copy must not drift with the server locale. */
function asDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isoOrNull(value: Date | null): ISODateTime | null {
  return value ? (value.toISOString() as ISODateTime) : null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
