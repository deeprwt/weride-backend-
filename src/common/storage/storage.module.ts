import { Global, Module, type Provider } from '@nestjs/common';
import { DocumentStorage, DOCUMENT_STORAGE } from './document-storage.interface';
import { LocalDiskDocumentStorage } from './local-disk-storage';
import { loadEnv } from '../../config/env';

/**
 * Boot-time factory: pick the document-storage driver from
 * DOCUMENT_STORAGE_DRIVER. Local disk is the default and needs no external
 * account, which keeps driver onboarding testable for free through Phase 3.
 *
 * The s3 case throws rather than falling back to disk. env.ts already refuses
 * to boot on DOCUMENT_STORAGE_DRIVER=s3, so this branch should be unreachable —
 * but a silent fallback would write KYC uploads to a container's ephemeral
 * filesystem, and the operator would only find out when the pod recycled.
 */
const documentStorageFactory: Provider = {
  provide: DocumentStorage,
  useFactory: (): DocumentStorage => {
    const env = loadEnv();
    if (env.DOCUMENT_STORAGE_DRIVER === 's3') {
      throw new Error(
        '[uride-api] DOCUMENT_STORAGE_DRIVER=s3 has no implementation yet. ' +
          'Refusing to fall back to local disk for KYC documents.',
      );
    }
    return new LocalDiskDocumentStorage();
  },
};

/**
 * Global so both DriversModule (upload, self-service download) and AdminModule
 * (reviewer download, purge on rejection) can inject the port without importing
 * one another — the two modules have no business knowing each other exists.
 */
@Global()
@Module({
  providers: [
    documentStorageFactory,
    { provide: DOCUMENT_STORAGE, useExisting: DocumentStorage },
  ],
  exports: [DocumentStorage, DOCUMENT_STORAGE],
})
export class StorageModule {}
