import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { DRIVER_DOCUMENT_MAX_BYTES } from '@uride/validation';
import { LocalDiskDocumentStorage } from './local-disk-storage';
import { _resetEnvCache } from '../../config/env';

/**
 * Real bytes rather than fixture files: what the leading bytes say is the whole
 * subject of most of these cases, so they are written inline, next to the
 * assertion that depends on them.
 */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-then-some-pixels'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF payload')]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n');
/** A perfectly valid file of a type we do not accept — the interesting rejection. */
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x01, 0x00, 0x01, 0x00])]);

/** A key of exactly the shape the driver mints, pointing at nothing. */
const WELL_FORMED_UNKNOWN_KEY = 'ab/cd/abcdef0123456789abcdef0123456789.png';

/**
 * Storage keys that must never be resolved against the filesystem. Each is a
 * plausible thing to find in a `storage_key` column after a bad import, a
 * hand-edited row, or an injection that got as far as the database.
 */
const HOSTILE_KEYS: readonly string[] = [
  '../sentinel.txt',
  '../../etc/passwd',
  'ab/cd/../../../sentinel.txt',
  '..\\..\\sentinel.txt',
  '/etc/passwd',
  'C:\\Windows\\win.ini',
  '\\\\server\\share\\secret.txt',
  'ab/cd/abcdef0123456789abcdef0123456789.png/../../../sentinel.txt',
  '%2e%2e%2fsentinel.txt',
  'ab/cd/abcdef0123456789abcdef0123456789.png\u0000.txt',
];

describe('LocalDiskDocumentStorage', () => {
  let parentDir: string;
  let rootDir: string;
  let sentinelPath: string;
  let storage: LocalDiskDocumentStorage;

  beforeAll(async () => {
    // The storage root sits one level down, so the tests have somewhere outside
    // it to put a file that a traversal would reach if the guard were wrong.
    parentDir = await realpath(await mkdtemp(join(tmpdir(), 'uride-storage-')));
    rootDir = join(parentDir, 'documents');
    sentinelPath = join(parentDir, 'sentinel.txt');

    _resetEnvCache();
    process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.DIRECT_URL = 'postgresql://x:y@localhost:5432/z';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.AUTH_PROVIDER = 'local';
    process.env.JWT_LOCAL_SECRET = 'a'.repeat(48);
    process.env.DOCUMENT_STORAGE_DRIVER = 'local';
    process.env.DOCUMENT_STORAGE_PATH = rootDir;

    storage = new LocalDiskDocumentStorage();
    await storage.onModuleInit();
  });

  beforeEach(async () => {
    await writeFile(sentinelPath, 'the file a traversal is trying to reach');
  });

  afterAll(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Admission control
  // -------------------------------------------------------------------------

  it('refuses a mime type that is not on the allow-list', async () => {
    const before = await storedFiles(rootDir);

    const error = await refusal(() =>
      storage.put({ bytes: GIF, fileName: 'licence.gif', declaredMimeType: 'image/gif' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(error.getResponse()).toMatchObject({ code: 'document_type_not_allowed' });
    // A rejected upload must never reach the store, or every refusal leaks a
    // file that nothing in the system will ever reference or clean up.
    expect(await storedFiles(rootDir)).toEqual(before);
  });

  it('refuses a file whose bytes disagree with its declared mime type', async () => {
    const before = await storedFiles(rootDir);

    // A JPEG renamed to .png is innocent; an HTML page or an executable posted
    // as image/png is what this check exists for, and from here they are the
    // same upload.
    const error = await refusal(() =>
      storage.put({ bytes: JPEG, fileName: 'licence.png', declaredMimeType: 'image/png' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(error.getResponse()).toMatchObject({ code: 'document_content_mismatch' });
    expect(await storedFiles(rootDir)).toEqual(before);
  });

  it('refuses content that is not one of the accepted formats at all', async () => {
    const error = await refusal(() =>
      storage.put({
        bytes: Buffer.from('<!doctype html><script>alert(1)</script>'),
        fileName: 'licence.pdf',
        declaredMimeType: 'application/pdf',
      }),
    );

    expect(error.getResponse()).toMatchObject({ code: 'document_unreadable' });
  });

  it('refuses an over-size upload', async () => {
    // Declared and sniffed types agree, so size is the only thing left to refuse.
    const oversize = Buffer.concat([PNG, Buffer.alloc(DRIVER_DOCUMENT_MAX_BYTES)]);
    expect(oversize.byteLength).toBeGreaterThan(DRIVER_DOCUMENT_MAX_BYTES);

    const error = await refusal(() =>
      storage.put({ bytes: oversize, fileName: 'huge.png', declaredMimeType: 'image/png' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(error.getResponse()).toMatchObject({ code: 'document_too_large' });
  });

  it('accepts a file sitting exactly on the size limit', async () => {
    const atLimit = Buffer.concat([PNG, Buffer.alloc(DRIVER_DOCUMENT_MAX_BYTES - PNG.byteLength)]);
    expect(atLimit.byteLength).toBe(DRIVER_DOCUMENT_MAX_BYTES);

    const stored = await storage.put({
      bytes: atLimit,
      fileName: 'exactly-at-the-cap.png',
      declaredMimeType: 'image/png',
    });

    expect(stored.sizeBytes).toBe(DRIVER_DOCUMENT_MAX_BYTES);
    await storage.delete(stored.storageKey);
  });

  it('refuses an empty file', async () => {
    const error = await refusal(() =>
      storage.put({
        bytes: Buffer.alloc(0),
        fileName: 'nothing.png',
        declaredMimeType: 'image/png',
      }),
    );

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({ code: 'document_empty' });
  });

  // -------------------------------------------------------------------------
  // Path containment — the one bug in this driver that would expose the disk
  // -------------------------------------------------------------------------

  describe('storage keys that try to escape the root', () => {
    it.each(HOSTILE_KEYS)('refuses %j on every path that touches the disk', async (key) => {
      const calls: ReadonlyArray<() => Promise<unknown>> = [
        () => storage.stat(key),
        () => storage.getStream(key),
        () => storage.delete(key),
      ];

      for (const call of calls) {
        const error = await refusal(call);
        expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(error.getResponse()).toMatchObject({ code: 'invalid_storage_key' });
      }

      // The refusal is only worth anything if the file it aimed at survived it.
      await expect(stat(sentinelPath)).resolves.toBeDefined();
    });

    // Without this the suite would still pass against a driver that threw on
    // every key, which would be broken rather than safe.
    it('still resolves a well-formed key that simply does not exist', async () => {
      await expect(storage.stat(WELL_FORMED_UNKNOWN_KEY)).resolves.toBeNull();
      await expect(storage.delete(WELL_FORMED_UNKNOWN_KEY)).resolves.toBeUndefined();

      const error = await refusal(() => storage.getStream(WELL_FORMED_UNKNOWN_KEY));
      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.getResponse()).toMatchObject({ code: 'document_not_found' });
    });

    it('refuses the staging directory, which holds half-written uploads', async () => {
      const error = await refusal(() => storage.getStream('.tmp/anything.part'));
      expect(error.getResponse()).toMatchObject({ code: 'invalid_storage_key' });
    });
  });

  // -------------------------------------------------------------------------
  // Round trip
  // -------------------------------------------------------------------------

  it.each([
    ['image/png', PNG, 'png'],
    ['image/jpeg', JPEG, 'jpg'],
    ['application/pdf', PDF, 'pdf'],
  ] as const)('round-trips a %s and returns a stable sha256', async (mime, bytes, extension) => {
    const stored = await storage.put({
      bytes,
      fileName: `licence.${extension}`,
      declaredMimeType: mime,
    });

    expect(stored.storageKey).toMatch(
      new RegExp(`^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{32}\\.${extension}$`),
    );
    expect(stored.mimeType).toBe(mime);
    expect(stored.sizeBytes).toBe(bytes.byteLength);
    expect(stored.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    const read = await collect(await storage.getStream(stored.storageKey));
    expect(read.equals(bytes)).toBe(true);

    expect(await storage.stat(stored.storageKey)).toMatchObject({
      storageKey: stored.storageKey,
      sizeBytes: bytes.byteLength,
    });

    await storage.delete(stored.storageKey);
    expect(await storage.stat(stored.storageKey)).toBeNull();
    // Idempotent: a re-upload deletes the superseded blob, and a retried delete
    // must not fail the request that carried it.
    await expect(storage.delete(stored.storageKey)).resolves.toBeUndefined();
  });

  it('gives identical bytes the same hash but different, unguessable keys', async () => {
    const first = await storage.put({
      bytes: PNG,
      fileName: 'licence.png',
      declaredMimeType: 'image/png',
    });
    const second = await storage.put({
      bytes: PNG,
      fileName: 'licence.png',
      declaredMimeType: 'image/png',
    });

    expect(second.contentSha256).toBe(first.contentSha256);
    // Keys are random rather than derived from the content or the owner, so one
    // leaked key never gives up the rest of an applicant's folder.
    expect(second.storageKey).not.toBe(first.storageKey);

    await storage.delete(first.storageKey);
    await storage.delete(second.storageKey);
  });

  it('records the type it sniffed, not the one the caller declared', async () => {
    // `IMAGE/JPEG; charset=binary` is a real thing clients send: it has to
    // normalise rather than be refused, and the stored type stays canonical.
    const stored = await storage.put({
      bytes: JPEG,
      fileName: 'licence.jpeg',
      declaredMimeType: 'IMAGE/JPEG; charset=binary',
    });

    expect(stored.mimeType).toBe('image/jpeg');
    await storage.delete(stored.storageKey);
  });

  it('leaves nothing behind in the staging directory', async () => {
    const stored = await storage.put({
      bytes: PDF,
      fileName: 'insurance.pdf',
      declaredMimeType: 'application/pdf',
    });

    expect(await readdir(join(rootDir, '.tmp'))).toEqual([]);
    await storage.delete(stored.storageKey);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a call that must be refused and hand the exception back. Returning it
 * rather than matching inline is what lets each case assert on the `{ code }`
 * body the API contract promises, instead of only on "something threw".
 */
async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused, but it resolved.');
}

/** Every stored document under the root, ignoring the staging directory. */
async function storedFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.parentPath.includes('.tmp'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}
