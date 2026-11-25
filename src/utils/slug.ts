/** "Carregador Anker 65W!" -> "carregador-anker-65w" (remove acentos). */
export function slugify(input: string, maxLength = 120): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** Gera slug único acrescentando -2, -3… quando já existe. */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base) || 'item';
  let candidate = root;
  for (let i = 2; await exists(candidate); i++) {
    candidate = `${root}-${i}`;
    if (i > 500) throw new Error('Could not generate a unique slug');
  }
  return candidate;
}
