import { env } from '../../../config/env';
import { CloudinaryStorageProvider } from './cloudinary.provider';
import { LocalStorageProvider } from './local.provider';
import type { StorageProvider } from './storage.provider';

export function createStorage(): StorageProvider {
  switch (env.STORAGE_DRIVER) {
    case 'cloudinary':
      return new CloudinaryStorageProvider({
        cloudName: env.CLOUDINARY_CLOUD_NAME!,
        apiKey: env.CLOUDINARY_API_KEY!,
        apiSecret: env.CLOUDINARY_API_SECRET!,
        folder: env.CLOUDINARY_FOLDER,
      });
    case 'local':
    default:
      return new LocalStorageProvider(env.STORAGE_LOCAL_DIR, env.STORAGE_PUBLIC_URL);
  }
}

export type { StorageProvider } from './storage.provider';
export { LocalStorageProvider } from './local.provider';
