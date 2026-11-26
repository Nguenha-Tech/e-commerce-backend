import type { DbClient } from '../../../db/client';
import type { StorageProvider, StoredFile, UploadInput } from './storage.provider';

/**
 * Guarda os ficheiros numa tabela do PostgreSQL (`stored_files`) e serve-os em
 * GET /uploads/<key>. Sem dependências externas — adequado para testes e para a
 * Vercel (disco efémero). Para volume real, preferir Cloudinary/S3.
 */
export class DatabaseStorageProvider implements StorageProvider {
  readonly name = 'database';

  constructor(
    private readonly db: DbClient,
    private readonly baseUrl: string,
  ) {}

  async upload({ key, body, contentType }: UploadInput): Promise<StoredFile> {
    await this.db.storedFile.create({ data: { key, contentType, sizeBytes: body.length, data: new Uint8Array(body) } });
    return { key, url: this.publicUrl(key), provider: this.name };
  }

  async delete(key: string): Promise<void> {
    await this.db.storedFile.deleteMany({ where: { key } });
  }

  async read(key: string) {
    return this.db.storedFile.findUnique({ where: { key }, select: { contentType: true, data: true } });
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/${key}`;
  }
}
