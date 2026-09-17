import type { Readable } from 'node:stream';
import { DRIVER_DOCUMENT_MIME_TYPES } from '@uride/validation';

/**
 * DocumentStorage — the port every driver-KYC upload passes through.
 *
 * The surface is deliberately tiny (put / getStream / stat / delete) because the
 * production driver is object storage: anything richer — listing, renaming,
 * server-side copies — would be either expensive or impossible to express over
 * S3, and would have to be torn out when we swap drivers. Everything a caller
 * needs beyond these four calls (owner, type, review state, original filename)
 * lives in `driver_documents`, not in the store.
 *
 * `put` takes the whole file as a Buffer rather than a stream. We must hash and
 * magic-byte-sniff the bytes before they are allowed to land, which means
 * holding them anyway, and DRIVER_DOCUMENT_MAX_BYTES (10 MB) bounds the cost.
 * Reads are streamed, since those go straight down an HTTP response.
 */

/** The mime types a document is allowed to be, narrowed from the contract's allow-list. */
export type DocumentMimeType = (typeof DRIVER_DOCUMENT_MIME_TYPES)[number];

export interface PutDocumentInput {
  /** The complete file. Rejected if empty or over DRIVER_DOCUMENT_MAX_BYTES. */
  bytes: Buffer;
  /**
   * The client's filename. Metadata only — it is never used to build the
   * storage key, so a hostile name cannot influence where the bytes land.
   */
  fileName: string;
  /** What the client claims the file is. Cross-checked against the magic bytes. */
  declaredMimeType: string;
}

export interface StoredDocument {
  /**
   * Opaque handle for the stored bytes. Carries no driver id, no filename and
   * no upload order — these are government ID scans, and a key that can be
   * guessed from a driver id is a key that can be enumerated.
   */
  storageKey: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the bytes, for `driver_documents.content_sha256`. */
  contentSha256: string;
  /**
   * The type we *sniffed*, not the one the client declared. Callers persist
   * this, so a lying client cannot get its own string into the DB and back out
   * again as a Content-Type header on download.
   */
  mimeType: DocumentMimeType;
}

export interface DocumentStat {
  storageKey: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export abstract class DocumentStorage {
  /**
   * Validate, hash and persist a document. Throws on anything that fails the
   * allow-list, the size cap or the magic-byte check — a rejected upload never
   * touches the store.
   */
  abstract put(input: PutDocumentInput): Promise<StoredDocument>;

  /** Open the stored bytes for streaming. Throws if the key is unknown. */
  abstract getStream(storageKey: string): Promise<Readable>;

  /** Metadata without reading the bytes; `null` when the key is unknown. */
  abstract stat(storageKey: string): Promise<DocumentStat | null>;

  /** Remove the bytes. Idempotent — deleting an already-gone key succeeds. */
  abstract delete(storageKey: string): Promise<void>;
}

/** Injection token, for consumers that prefer a symbol over the abstract class. */
export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

// ---------------------------------------------------------------------------
// Content inspection — shared by every driver
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Acrobat tolerates junk ahead of the `%PDF-` header and so do most scanners
 * and phone "print to PDF" pipelines. Rejecting those would block a real driver
 * from onboarding, so we scan a short prefix instead of demanding offset 0.
 */
const PDF_HEADER_SCAN_BYTES = 1024;

/**
 * Identify a file from its leading bytes. Returns null when the content is not
 * one of the four accepted formats — including the case where it is a perfectly
 * valid file of some *other* type, which is exactly the upload we want to stop.
 */
export function sniffMimeType(bytes: Buffer): DocumentMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  // RIFF container whose form type is WEBP; the 4 bytes between are the length.
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.subarray(0, PDF_HEADER_SCAN_BYTES).includes('%PDF-')) {
    return 'application/pdf';
  }
  return null;
}

/** Strip parameters and case from a Content-Type so `IMAGE/JPEG; charset=x` compares cleanly. */
export function normalizeMimeType(declared: string): string {
  const [head = ''] = declared.split(';');
  return head.trim().toLowerCase();
}

export function isAllowedMimeType(value: string): value is DocumentMimeType {
  return (DRIVER_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}
