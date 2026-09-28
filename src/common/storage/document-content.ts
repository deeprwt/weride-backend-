import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  type Logger,
} from '@nestjs/common';
import { DRIVER_DOCUMENT_MAX_BYTES } from '@uride/validation';
import {
  isAllowedMimeType,
  normalizeMimeType,
  sniffMimeType,
  type DocumentMimeType,
  type PutDocumentInput,
} from './document-storage.interface';

/**
 * Validation and key minting shared by every DocumentStorage driver.
 *
 * These two things must not be reimplemented per driver. The magic-byte check
 * is the only barrier between a renamed executable and a reviewer's browser,
 * and the key shape is what lets a deployment migrate from disk to Supabase
 * without rewriting `driver_documents.storage_key`. A fix applied to one copy
 * and not the other is the failure mode this file exists to prevent.
 */

/** File extension per accepted type, so a key is self-describing for ops. */
export const EXTENSION: Record<DocumentMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * The only shape a storage key may take: `ab/cd/<32 hex>.<ext>`. Anything else
 * — an absolute path, `..`, a backslash, a NUL byte, a UNC prefix — fails this
 * test before it reaches a filesystem or an object-store URL. The two-level
 * fan-out keeps any single directory to a few thousand entries at fleet scale.
 */
export const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}\.(?:jpg|png|webp|pdf)$/;

const MAX_MEGABYTES = Math.floor(DRIVER_DOCUMENT_MAX_BYTES / (1024 * 1024));

/**
 * Size, allow-list and content checks, cheapest first. Returns the *sniffed*
 * type, which is the only type a caller is allowed to persist — a lying client
 * must not be able to get its own string into the DB and back out again as a
 * Content-Type header on download.
 */
export function verifyDocument(input: PutDocumentInput, logger: Logger): DocumentMimeType {
  const sizeBytes = input.bytes.byteLength;
  if (sizeBytes === 0) {
    throw new BadRequestException({
      code: 'document_empty',
      message: 'The uploaded file is empty.',
    });
  }
  if (sizeBytes > DRIVER_DOCUMENT_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: 'document_too_large',
      message: `Documents must be ${MAX_MEGABYTES} MB or smaller.`,
    });
  }

  const declared = normalizeMimeType(input.declaredMimeType);
  if (!isAllowedMimeType(declared)) {
    throw new UnsupportedMediaTypeException({
      code: 'document_type_not_allowed',
      message: 'Documents must be a JPEG, PNG, WebP or PDF file.',
    });
  }

  const sniffed = sniffMimeType(input.bytes);
  if (!sniffed) {
    throw new UnsupportedMediaTypeException({
      code: 'document_unreadable',
      message: 'The file is not a readable JPEG, PNG, WebP or PDF.',
    });
  }
  // The mismatch case is the interesting one: a renamed executable, or an HTML
  // page posted as image/jpeg. Refuse instead of quietly trusting the sniff, so
  // the attempt shows up in the logs.
  if (sniffed !== declared) {
    logger.warn(`document content mismatch declared=${declared} sniffed=${sniffed}`);
    throw new UnsupportedMediaTypeException({
      code: 'document_content_mismatch',
      message: 'The file contents do not match its declared type.',
    });
  }
  return sniffed;
}

/**
 * 128 bits of randomness, fanned out over two directory levels taken from the
 * key itself so the path stays derivable from the key and nothing else. These
 * are government ID scans: a key derived from a driver id would be a key an
 * attacker could enumerate.
 */
export function newStorageKey(mimeType: DocumentMimeType): string {
  const id = randomBytes(16).toString('hex');
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.${EXTENSION[mimeType]}`;
}

/** Reject any key that did not come out of `newStorageKey`. */
export function assertValidStorageKey(storageKey: string): void {
  if (!KEY_PATTERN.test(storageKey)) {
    throw new BadRequestException({
      code: 'invalid_storage_key',
      message: 'Invalid document reference.',
    });
  }
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
