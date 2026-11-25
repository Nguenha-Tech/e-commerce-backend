import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { Errors } from '../../utils/errors';
import { assertDeclaredType, processImage } from './image.processor';
import type { StorageProvider } from './storage/storage.provider';

export const UPLOAD_FOLDERS = ['products', 'categories', 'brands', 'banners', 'reviews', 'returns', 'avatars', 'misc'] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

export interface UploadedImage {
  url: string;
  thumbnailUrl: string;
  storageKey: string;
  thumbnailKey: string;
  storageProvider: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
}

function buildKey(folder: UploadFolder, suffix = '') {
  const now = new Date();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${folder}/${now.getUTCFullYear()}/${mm}/${randomUUID()}${suffix}.webp`;
}

export class UploadsService {
  constructor(private readonly storage: StorageProvider) {}

  /** Lê o stream respeitando o limite configurado no multipart. */
  private async readFile(file: MultipartFile): Promise<Buffer> {
    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      throw Errors.badRequest('FILE_TOO_LARGE', `Maximum file size is ${env.UPLOAD_MAX_FILE_SIZE_MB}MB`);
    }
    return buffer;
  }

  async uploadImage(file: MultipartFile, folder: UploadFolder): Promise<UploadedImage> {
    assertDeclaredType(file.filename, file.mimetype);
    const raw = await this.readFile(file);
    const img = await processImage(raw);

    const key = buildKey(folder);
    const thumbKey = key.replace(/\.webp$/, '_thumb.webp');
    const main = await this.storage.upload({ key, body: img.main, contentType: img.contentType });
    let thumb;
    try {
      thumb = await this.storage.upload({ key: thumbKey, body: img.thumbnail, contentType: img.contentType });
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
    return {
      url: main.url,
      thumbnailUrl: thumb.url,
      storageKey: key,
      thumbnailKey: thumbKey,
      storageProvider: main.provider,
      width: img.width,
      height: img.height,
      sizeBytes: img.main.length,
      mimeType: img.contentType,
    };
  }

  /** Processa todas as partes "file" de um pedido multipart; devolve também os campos de texto. */
  async uploadFromRequest(request: FastifyRequest, folder: UploadFolder) {
    const uploaded: UploadedImage[] = [];
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (uploaded.length >= env.UPLOAD_MAX_FILES) throw Errors.badRequest('TOO_MANY_FILES', 'Too many files');
          uploaded.push(await this.uploadImage(part, folder));
        } else {
          fields[part.fieldname] = String(part.value).slice(0, 500);
        }
      }
    } catch (err) {
      // Não deixar ficheiros órfãos se algo falhar a meio.
      await this.removeImages(uploaded);
      throw err;
    }
    if (uploaded.length === 0) throw Errors.badRequest('NO_FILES', 'No image files were sent');
    return { files: uploaded, fields };
  }

  async removeImages(images: Array<{ storageKey: string; thumbnailKey?: string | null }>) {
    await Promise.all(
      images.flatMap((i) => [i.storageKey, i.thumbnailKey].filter((k): k is string => Boolean(k)).map((k) => this.storage.delete(k).catch(() => undefined))),
    );
  }
}
