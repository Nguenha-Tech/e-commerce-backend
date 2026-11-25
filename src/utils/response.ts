export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Envelope padrão de sucesso: { success, message, data, meta? }. */
export function ok<T>(data: T, message = 'OK', meta?: PageMeta | Record<string, unknown>) {
  return meta ? { success: true as const, message, data, meta } : { success: true as const, message, data };
}
