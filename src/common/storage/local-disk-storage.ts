import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { DRIVER_DOCUMENT_MAX_BYTES } from '@uride/validation';
import {
  DocumentStorage,
  isAllowedMimeType,
  normalizeMimeType,
  sniffMimeType,
  type DocumentMimeType,
  type DocumentStat,
  type PutDocumentInput,
  type StoredDocument,
} from './document-storage.interface';
import { loadEnv } from '../../config/env';

/** File extension per accepted type, so a key is self-describing on disk for ops. */
const EXTENSION: Record<DocumentMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * The only shape a storage key may take: `ab/cd/<32 hex>.<ext>`. Anything else
 * — an absolute path, `..`, a backslash, a NUL byte, a UNC prefix — fails this
 * test before it ever reaches the filesystem. The two-level fan-out keeps any
 * single directory to a few thousand entries at fleet scale.
 */
const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}\.(?:jpg|png|webp|pdf)$/;

/** Staging area for half-written uploads. Unreachable via KEY_PATTERN, so never served. */
const TMP_DIR = '.tmp';

/** Owner-only. Largely a no-op on Windows, which is dev-only for this driver. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const MAX_MEGABYTES = Math.floor(DRIVER_DOCUMENT_MAX_BYTES / (1024 * 1024));

/**
 * LocalDiskDocumentStorage — the free, offline-capable driver used through
 * Phase 3. Bytes go under DOCUMENT_STORAGE_PATH; production swaps in S3 without
 * touching a single caller or the `storage_key` column.
 *
 * Two properties matter more here than throughput does. First, keys are random
 * rather than derived: a document's path reveals nothing about whose licence it
 * is, so a leaked key does not hand over the rest of that application's folder.
 * Second, writes are staged and renamed, so a crash mid-upload leaves a stray
 * temp file rather than a truncated ID scan that a reviewer would approve.
 */
@Injectable()
export class LocalDiskDocumentStorage extends DocumentStorage implements OnModuleInit {
  private readonly logger = new Logger(LocalDiskDocumentStorage.name);
  private readonly configuredPath: string;
  private rootPromise: Promise<string> | null = null;

  constructor() {
    super();
    this.configuredPath = loadEnv().DOCUMENT_STORAGE_PATH;
  }

  /**
   * Create the storage tree eagerly so a bad path (missing volume, no write
   * permission) fails the deploy, rather than surfacing hours later as a 503 on
   * the first driver who tries to upload a licence.
   */
  async onModuleInit(): Promise<void> {
    await this.root();
  }

  async put(input: PutDocumentInput): Promise<StoredDocument> {
    const mimeType = this.verify(input);

    const sizeBytes = input.bytes.byteLength;
    const contentSha256 = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = newStorageKey(mimeType);

    const absolutePath = await this.pathFor(storageKey);
    const root = await this.root();
    const tempPath = join(root, TMP_DIR, `${randomBytes(12).toString('hex')}.part`);

    await mkdir(dirname(absolutePath), { recursive: true, mode: DIR_MODE });
    try {
      const handle = await open(tempPath, 'wx', FILE_MODE);
      try {
        await handle.writeFile(input.bytes);
        // Flush before the rename: a document that survives the API's 201 but
        // not a power loss would leave a driver approved against nothing.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, absolutePath);
    } catch (err: unknown) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      this.logger.error(`document write failed key=${storageKey}: ${describe(err)}`);
      throw new ServiceUnavailableException({
        code: 'document_storage_unavailable',
        message: 'Could not store the document. Please try again.',
      });
    }

    this.logger.log(`document stored key=${storageKey} bytes=${sizeBytes} type=${mimeType}`);
    return { storageKey, sizeBytes, contentSha256, mimeType };
  }

  async getStream(storageKey: string): Promise<Readable> {
    const absolutePath = await this.pathFor(storageKey);
    // Probe first: a stream that fails asynchronously would blow up after the
    // caller has already begun writing the HTTP response.
    if (!(await statOrNull(absolutePath))) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Document not found.',
      });
    }
    return createReadStream(absolutePath);
  }

  async stat(storageKey: string): Promise<DocumentStat | null> {
    const absolutePath = await this.pathFor(storageKey);
    const info = await statOrNull(absolutePath);
    if (!info) return null;
    return { storageKey, sizeBytes: info.size, modifiedAt: info.mtime };
  }

  /**
   * Idempotent by design. Re-uploading a document type deletes the superseded
   * row and its bytes, so a retried or duplicated delete must not fail the
   * request that carried it.
   */
  async delete(storageKey: string): Promise<void> {
    const absolutePath = await this.pathFor(storageKey);
    try {
      await rm(absolutePath, { force: true });
    } catch (err: unknown) {
      this.logger.error(`document delete failed key=${storageKey}: ${describe(err)}`);
      throw new ServiceUnavailableException({
        code: 'document_storage_unavailable',
        message: 'Could not delete the document. Please try again.',
      });
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Size, allow-list and content checks, cheapest first. Returns the sniffed
   * type, which is the only type the caller is allowed to persist.
   */
  private verify(input: PutDocumentInput): DocumentMimeType {
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
    // The mismatch case is the interesting one: a renamed executable, or an
    // HTML page posted as image/jpeg. Refuse instead of quietly trusting the
    // sniff, so the attempt shows up in the logs.
    if (sniffed !== declared) {
      this.logger.warn(`document content mismatch declared=${declared} sniffed=${sniffed}`);
      throw new UnsupportedMediaTypeException({
        code: 'document_content_mismatch',
        message: 'The file contents do not match its declared type.',
      });
    }
    return sniffed;
  }

  /**
   * Resolve a key to an absolute path, refusing anything that could escape the
   * storage root. KEY_PATTERN already excludes traversal sequences; the
   * containment check stays as a second, explicit barrier because this is the
   * one bug in this file that would expose the whole filesystem.
   */
  private async pathFor(storageKey: string): Promise<string> {
    if (!KEY_PATTERN.test(storageKey)) {
      throw new BadRequestException({
        code: 'invalid_storage_key',
        message: 'Invalid document reference.',
      });
    }
    const root = await this.root();
    const absolutePath = resolve(root, storageKey);
    if (!absolutePath.startsWith(root + sep)) {
      this.logger.error(`storage key escaped the document root: ${storageKey}`);
      throw new BadRequestException({
        code: 'invalid_storage_key',
        message: 'Invalid document reference.',
      });
    }
    return absolutePath;
  }

  /** Memoised root: created once on first use, then reused by every call. */
  private root(): Promise<string> {
    if (!this.rootPromise) {
      // Clear the memo on failure so a transient error — a volume that mounts a
      // moment after boot — cannot poison the process for its whole lifetime.
      this.rootPromise = this.initRoot().catch((err: unknown) => {
        this.rootPromise = null;
        throw err;
      });
    }
    return this.rootPromise;
  }

  private async initRoot(): Promise<string> {
    const configured = resolve(process.cwd(), this.configuredPath);
    try {
      await mkdir(configured, { recursive: true, mode: DIR_MODE });
      await mkdir(join(configured, TMP_DIR), { recursive: true, mode: DIR_MODE });
      // Canonicalise once, so the containment check compares real paths and a
      // symlinked storage root cannot be used to sidestep it.
      const root = await realpath(configured);
      this.logger.log(`Document storage ready at ${root}`);
      return root;
    } catch (err: unknown) {
      this.logger.error(`Document storage unavailable at ${configured}: ${describe(err)}`);
      throw new ServiceUnavailableException({
        code: 'document_storage_unavailable',
        message: 'Document storage is unavailable.',
      });
    }
  }
}

/**
 * 128 bits of randomness, fanned out over two directory levels taken from the
 * key itself so the path stays derivable from the key and nothing else.
 */
function newStorageKey(mimeType: DocumentMimeType): string {
  const id = randomBytes(16).toString('hex');
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.${EXTENSION[mimeType]}`;
}

async function statOrNull(absolutePath: string): Promise<{ size: number; mtime: Date } | null> {
  try {
    const info = await stat(absolutePath);
    return info.isFile() ? { size: info.size, mtime: info.mtime } : null;
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
