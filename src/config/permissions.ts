/**
 * Catálogo de permissões (recurso:ação). É a fonte de verdade para o seed e para
 * as verificações nas rotas. Novas roles combinam estas permissões via API.
 */
export const PERMISSIONS = {
  PRODUCTS_READ: 'products:read',
  PRODUCTS_CREATE: 'products:create',
  PRODUCTS_UPDATE: 'products:update',
  PRODUCTS_DELETE: 'products:delete',
  CATEGORIES_MANAGE: 'categories:manage',
  BRANDS_MANAGE: 'brands:manage',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_MANAGE: 'inventory:manage',
  ORDERS_READ: 'orders:read',
  ORDERS_MANAGE: 'orders:manage',
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_MANAGE: 'payments:manage',
  REFUNDS_MANAGE: 'refunds:manage',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_BLOCK: 'customers:block',
  CUSTOMERS_UPDATE_SENSITIVE: 'customers:update_sensitive',
  PROMOTIONS_MANAGE: 'promotions:manage',
  COUPONS_MANAGE: 'coupons:manage',
  REVIEWS_MODERATE: 'reviews:moderate',
  QUESTIONS_MODERATE: 'questions:moderate',
  BANNERS_MANAGE: 'banners:manage',
  CONTENT_MANAGE: 'content:manage',
  UPLOADS_CREATE: 'uploads:create',
  DASHBOARD_READ: 'dashboard:read',
  REPORTS_READ: 'reports:read',
  REPORTS_FINANCIAL: 'reports:financial',
  ADMINS_MANAGE: 'admins:manage',
  ROLES_MANAGE: 'roles:manage',
  SETTINGS_MANAGE: 'settings:manage',
  PAYMENT_METHODS_MANAGE: 'payment_methods:manage',
  SHIPPING_METHODS_MANAGE: 'shipping_methods:manage',
  WHATSAPP_MANAGE: 'whatsapp:manage',
  AUDIT_READ: 'audit:read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

const P = PERMISSIONS;

const ADMIN_PERMISSIONS: Permission[] = [
  P.PRODUCTS_READ, P.PRODUCTS_CREATE, P.PRODUCTS_UPDATE, P.PRODUCTS_DELETE,
  P.CATEGORIES_MANAGE, P.BRANDS_MANAGE,
  P.INVENTORY_READ, P.INVENTORY_MANAGE,
  P.ORDERS_READ, P.ORDERS_MANAGE, P.PAYMENTS_READ,
  P.CUSTOMERS_READ, P.CUSTOMERS_BLOCK,
  P.PROMOTIONS_MANAGE, P.COUPONS_MANAGE, P.REVIEWS_MODERATE, P.QUESTIONS_MODERATE,
  P.BANNERS_MANAGE, P.CONTENT_MANAGE, P.UPLOADS_CREATE,
  P.DASHBOARD_READ, P.REPORTS_READ,
];

export const SYSTEM_ROLES = {
  CUSTOMER: { level: 0, description: 'Cliente da loja', permissions: [] as Permission[] },
  ADMIN: { level: 50, description: 'Administrador da plataforma', permissions: ADMIN_PERMISSIONS },
  OWNER: { level: 100, description: 'Dono/gestor da loja — acesso total', permissions: ALL_PERMISSIONS },
} as const;

export type SystemRoleName = keyof typeof SYSTEM_ROLES;

export function permissionGroup(key: string): string {
  return key.split(':')[0] ?? 'misc';
}
