/**
 * Abstração de armazenamento de ficheiros. A BD guarda apenas `key` + `url`.
 * Implementações: LocalStorageProvider, CloudinaryStorageProvider.
 * S3 / R2 / GCS / CDN implementam esta mesma interface.
 */
export interface UploadInput {
  /** Chave gerada pelo servidor, ex.: products/2026/10/<uuid>.webp — nunca o nome original. */
  key: string;
  body: Buffer;
  contentType: string;
}

export interface StoredFile {
  key: string;
  url: string;
  provider: string;
}

export interface StorageProvider {
  readonly name: string;
  upload(input: UploadInput): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}
