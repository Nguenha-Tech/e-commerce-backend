import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import type { StorageProvider, StoredFile, UploadInput } from './storage.provider';

interface CloudinaryOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

/** Cloudinary como storage + CDN. A chave (sem extensão) é o public_id. */
export class CloudinaryStorageProvider implements StorageProvider {
  readonly name = 'cloudinary';

  constructor(private readonly opts: CloudinaryOptions) {
    cloudinary.config({ cloud_name: opts.cloudName, api_key: opts.apiKey, api_secret: opts.apiSecret, secure: true });
  }

  private publicId(key: string) {
    return `${this.opts.folder}/${key.replace(/\.[a-z0-9]+$/i, '')}`;
  }

  upload({ key, body }: UploadInput): Promise<StoredFile> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { public_id: this.publicId(key), resource_type: 'image', overwrite: false, unique_filename: false },
        (error, result?: UploadApiResponse) => {
          if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'));
          resolve({ key, url: result.secure_url, provider: this.name });
        },
      );
      stream.end(body);
    });
  }

  async delete(key: string): Promise<void> {
    await cloudinary.uploader.destroy(this.publicId(key), { resource_type: 'image', invalidate: true });
  }

  publicUrl(key: string): string {
    return cloudinary.url(this.publicId(key), { secure: true, format: 'webp' });
  }
}
