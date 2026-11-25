import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Errors } from '../../../utils/errors';
import type { StorageProvider, StoredFile, UploadInput } from './storage.provider';

const SAFE_KEY = /^[a-z0-9][a-z0-9/_-]*\.[a-z0-9]+$/i;

/** Guarda ficheiros no disco (desenvolvimento ou volume partilhado + CDN à frente). */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(rootDir: string, private readonly baseUrl: string) {
    this.root = path.resolve(rootDir);
  }

  /** Impede path traversal: a chave tem formato restrito e o caminho final fica dentro da raiz. */
  private resolveKey(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw Errors.badRequest('INVALID_STORAGE_KEY', 'Invalid storage key');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw Errors.badRequest('INVALID_STORAGE_KEY', 'Invalid storage key');
    return full;
  }

  async upload({ key, body }: UploadInput): Promise<StoredFile> {
    const full = this.resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, { flag: 'wx' }); // nunca sobrescrever
    return { key, url: this.publicUrl(key), provider: this.name };
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/${key}`;
  }

  get rootDir() {
    return this.root;
  }
}
