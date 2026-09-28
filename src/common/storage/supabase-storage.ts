import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DocumentStorage,
  type DocumentStat,
  type PutDocumentInput,
  type StoredDocument,
} from './document-storage.interface';
import {
  assertValidStorageKey,
  describeError,
  newStorageKey,
  verifyDocument,
} from './document-content';
import { loadEnv } from '../../config/env';

/**
 * SupabaseDocumentStorage — KYC documents in Supabase Storage.
 *
 * Talks the Storage REST API over `fetch` rather than pulling in
 * `@supabase/supabase-js` or the AWS SDK. Four verbs against four URLs does not
 * justify either dependency, and the S3-compatible endpoint would add a signing
 * implementation for no benefit when the service-role key authenticates here
 * with a bearer header.
 *
 * Two invariants this driver depends on, neither enforceable from code:
 *
 *  1. **The bucket must be private.** The service-role key bypasses RLS, so
 *     every call here succeeds regardless of policy. What keeps a licence scan
 *     from being world-readable is the bucket's own public flag being off.
 *     A public bucket means anyone holding a key can fetch it with no auth.
 *  2. **Downloads stay behind the API.** `getStream` pipes bytes through our
 *     own authenticated handler. We never mint public or signed URLs, so the
 *     caller's permission check cannot be bypassed by passing a link around.
 */
@Injectable()
export class SupabaseDocumentStorage extends DocumentStorage implements OnModuleInit {
  private readonly logger = new Logger(SupabaseDocumentStorage.name);
  private readonly bucket: string;
  private readonly serviceRoleKey: string;
  private readonly objectBase: string;
  private readonly timeoutMs: number;

  constructor() {
    super();
    const env = loadEnv();
    // env.ts has already refused to boot if either of these is missing.
    const projectUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
    this.serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    this.bucket = env.SUPABASE_STORAGE_BUCKET;
    this.objectBase = `${projectUrl}/storage/v1/object`;
    this.timeoutMs = env.SUPABASE_STORAGE_TIMEOUT_MS;
  }

  /**
   * Prove the bucket exists and the key works before the first driver tries to
   * upload a licence. A typo'd bucket name would otherwise surface hours later
   * as a 503 in the middle of onboarding.
   */
  async onModuleInit(): Promise<void> {
    const url = `${this.objectBase}/list/${encodeURIComponent(this.bucket)}`;
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 1 }),
      });
    } catch (err: unknown) {
      throw new ServiceUnavailableException(
        `[uride-api] Supabase Storage unreachable at ${this.objectBase}: ${describeError(err)}`,
      );
    }
    if (!response.ok) {
      const detail = await readBody(response);
      throw new ServiceUnavailableException(
        `[uride-api] Supabase Storage bucket '${this.bucket}' is not usable ` +
          `(HTTP ${response.status}): ${detail}. Create it as a PRIVATE bucket ` +
          `and check SUPABASE_SERVICE_ROLE_KEY.`,
      );
    }
    this.logger.log(`Document storage ready: Supabase bucket '${this.bucket}'`);
  }

  async put(input: PutDocumentInput): Promise<StoredDocument> {
    const mimeType = verifyDocument(input, this.logger);

    const sizeBytes = input.bytes.byteLength;
    const contentSha256 = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = newStorageKey(mimeType);

    let response: Response;
    try {
      response = await this.request(this.urlFor(storageKey), {
        method: 'POST',
        headers: {
          'content-type': mimeType,
          // Never overwrite. Keys are random, so a collision means a bug or a
          // replayed request — either way, silently clobbering an existing ID
          // scan is the wrong answer.
          'x-upsert': 'false',
          'cache-control': 'no-store',
        },
        body: new Uint8Array(input.bytes),
      });
    } catch (err: unknown) {
      this.logger.error(`document upload failed key=${storageKey}: ${describeError(err)}`);
      throw this.unavailable('Could not store the document. Please try again.');
    }

    if (!response.ok) {
      const detail = await readBody(response);
      this.logger.error(
        `document upload rejected key=${storageKey} status=${response.status}: ${detail}`,
      );
      throw this.unavailable('Could not store the document. Please try again.');
    }

    this.logger.log(`document stored key=${storageKey} bytes=${sizeBytes} type=${mimeType}`);
    return { storageKey, sizeBytes, contentSha256, mimeType };
  }

  async getStream(storageKey: string): Promise<Readable> {
    assertValidStorageKey(storageKey);

    let response: Response;
    try {
      response = await this.request(this.urlFor(storageKey), { method: 'GET' });
    } catch (err: unknown) {
      this.logger.error(`document read failed key=${storageKey}: ${describeError(err)}`);
      throw this.unavailable('Could not read the document. Please try again.');
    }

    if (response.status === 404) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Document not found.',
      });
    }
    if (!response.ok || !response.body) {
      const detail = await readBody(response);
      this.logger.error(`document read rejected key=${storageKey} status=${response.status}: ${detail}`);
      throw this.unavailable('Could not read the document. Please try again.');
    }

    // Web ReadableStream -> Node Readable, so callers can keep piping into an
    // HTTP response exactly as they do for the local-disk driver.
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  async stat(storageKey: string): Promise<DocumentStat | null> {
    assertValidStorageKey(storageKey);

    const url = `${this.objectBase}/info/${encodeURIComponent(this.bucket)}/${storageKey}`;
    let response: Response;
    try {
      response = await this.request(url, { method: 'GET' });
    } catch (err: unknown) {
      this.logger.error(`document stat failed key=${storageKey}: ${describeError(err)}`);
      return null;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      this.logger.error(`document stat rejected key=${storageKey} status=${response.status}`);
      return null;
    }

    const info = (await response.json().catch(() => null)) as SupabaseObjectInfo | null;
    if (!info) return null;

    const size = Number(info.size ?? info.contentLength ?? 0);
    const modified = info.last_modified ?? info.updated_at ?? info.created_at;
    return {
      storageKey,
      sizeBytes: Number.isFinite(size) ? size : 0,
      modifiedAt: modified ? new Date(modified) : new Date(0),
    };
  }

  /**
   * Idempotent by design. Re-uploading a document type deletes the superseded
   * row and its bytes, so a retried or duplicated delete must not fail the
   * request that carried it — a 404 here is success.
   */
  async delete(storageKey: string): Promise<void> {
    assertValidStorageKey(storageKey);

    let response: Response;
    try {
      response = await this.request(this.urlFor(storageKey), { method: 'DELETE' });
    } catch (err: unknown) {
      this.logger.error(`document delete failed key=${storageKey}: ${describeError(err)}`);
      throw this.unavailable('Could not delete the document. Please try again.');
    }
    if (response.ok || response.status === 404) return;

    const detail = await readBody(response);
    this.logger.error(
      `document delete rejected key=${storageKey} status=${response.status}: ${detail}`,
    );
    throw this.unavailable('Could not delete the document. Please try again.');
  }

  // -------------------------------------------------------------------------

  private urlFor(storageKey: string): string {
    // storageKey is `ab/cd/<32hex>.<ext>` and already validated — every segment
    // is hex or a known extension, so there is nothing here to percent-encode.
    return `${this.objectBase}/${encodeURIComponent(this.bucket)}/${storageKey}`;
  }

  /**
   * A hung storage call must not hold an upload request open indefinitely —
   * without this, a Supabase incident becomes exhausted Node handles.
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.serviceRoleKey}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private unavailable(message: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'document_storage_unavailable',
      message,
    });
  }
}

interface SupabaseObjectInfo {
  size?: number;
  contentLength?: number;
  last_modified?: string;
  updated_at?: string;
  created_at?: string;
}

/** Read an error body for the log without letting a huge response blow up memory. */
async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}
