import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DocumentStorage,
  type DocumentStat,
  type PutDocumentInput,
  type StoredDocument,
} from './document-storage.interface';
import { KEY_PATTERN, newStorageKey, verifyDocument } from './document-content';
import { loadEnv } from '../../config/env';

/** Staging area for half-written uploads. Unreachable via KEY_PATTERN, so never served. */
const TMP_DIR = '.tmp';

/** Owner-only. Largely a no-op on Windows, which is dev-only for this driver. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;


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
    const mimeType = verifyDocument(input, this.logger);

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
