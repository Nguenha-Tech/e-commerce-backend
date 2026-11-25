import sharp from 'sharp';
import { Errors } from '../../utils/errors';

export const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
export const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);
/** Formatos reais aceites (detetados pelos bytes, não pelo nome nem pelo header). */
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']); // avif é reportado como heif

const MAX_INPUT_PIXELS = 40_000_000; // proteção contra "decompression bombs"
const MAIN_MAX_SIZE = 2000;
const THUMB_SIZE = 400;

export interface ProcessedImage {
  main: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  contentType: 'image/webp';
  extension: 'webp';
}

/** Validação superficial do que o cliente declarou (extensão + MIME). */
export function assertDeclaredType(filename: string, mimetype: string): void {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (!ALLOWED_EXTENSIONS.has(ext)) throw Errors.badRequest('INVALID_FILE_EXTENSION', 'Only JPG, PNG, WEBP or AVIF images are allowed');
  if (!ALLOWED_MIME_TYPES.has(mimetype)) throw Errors.badRequest('INVALID_FILE_TYPE', 'Unsupported image MIME type');
}

/**
 * Validação real + normalização: deteta o formato pelos bytes, rejeita ficheiros
 * corrompidos/disfarçados, remove metadados (EXIF/GPS), redimensiona, converte para
 * WebP e gera thumbnail.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw Errors.badRequest('INVALID_IMAGE', 'File is not a valid image');
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
    throw Errors.badRequest('INVALID_IMAGE', 'File content is not a supported image format');
  }
  if (!meta.width || !meta.height || meta.width < 50 || meta.height < 50) {
    throw Errors.badRequest('IMAGE_TOO_SMALL', 'Image must be at least 50x50 pixels');
  }

  try {
    const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate(); // aplica orientação EXIF e descarta metadados
    const { data: main, info } = await base
      .clone()
      .resize({ width: MAIN_MAX_SIZE, height: MAIN_MAX_SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumbnail = await base
      .clone()
      .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    return { main, thumbnail, width: info.width, height: info.height, contentType: 'image/webp', extension: 'webp' };
  } catch {
    throw Errors.badRequest('INVALID_IMAGE', 'Image could not be processed');
  }
}
