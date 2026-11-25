import { ALL_PERMISSIONS, permissionGroup } from '../../config/permissions';
import { OrderStatus, PaymentStatus, prisma, Prisma, UserStatus } from '../../db/client';
import { recordAudit, type AuditContext } from '../../utils/audit';
import { hashPassword } from '../../utils/crypto';
import { Errors } from '../../utils/errors';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import {
  assertCanAssignRoles,
  assertCanGrantPermissions,
  assertCanManageUser,
  assertRoleLevelAllowed,
  type Actor,
} from './rbac';
import { addressSelect } from './users.service';

interface ListParams {
  page: number;
  limit: number;
  search?: string;
  status?: UserStatus;
}

const listSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { name: true } } } },
} as const;

const roleWithPerms = { permissions: { select: { permission: { select: { key: true } } } } } as const;

async function userLevel(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, email: true, status: true, roles: { select: { role: { select: { name: true, level: true } } } } },
  });
  if (!user) throw Errors.notFound('User');
  return { ...user, level: Math.max(0, ...user.roles.map((r) => r.role.level)) };
}

async function loadRoles(names: string[]) {
  const roles = await prisma.role.findMany({ where: { name: { in: names } }, include: roleWithPerms });
  const missing = names.filter((n) => !roles.some((r) => r.name === n));
  if (missing.length) throw Errors.badRequest('ROLE_NOT_FOUND', 'Some roles do not exist', { missing });
  return roles.map((r) => ({ ...r, permissionKeys: r.permissions.map((p) => p.permission.key) }));
}

export class UsersAdminService {
  // ---------------------------------------------------------------- clientes
  async listCustomers(params: ListParams) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      roles: { some: { role: { name: 'CUSTOMER' } } },
      ...(params.status ? { status: params.status } : {}),
      ...(params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { email: { contains: params.search, mode: 'insensitive' } },
              { phone: { contains: params.search } },
            ],
          }
        : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, select: listSelect, orderBy: { createdAt: 'desc' }, ...toSkipTake(params) }),
    ]);
    return { items: rows.map(flattenRoles), meta: pageMeta(total, params) };
  }

  async getCustomer(id: string) {
    const user = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...listSelect,
        avatarUrl: true,
        country: true,
        province: true,
        city: true,
        blockedReason: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        addresses: { where: { deletedAt: null }, select: addressSelect },
        _count: { select: { orders: true, reviews: true } },
        wishlist: { select: { _count: { select: { items: true } } } },
      },
    });
    if (!user) throw Errors.notFound('Customer');

    const [spent, recentOrders, activeSessions] = await Promise.all([
      prisma.order.aggregate({
        where: { userId: id, paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] }, status: { not: OrderStatus.CANCELLED } },
        _sum: { grandTotal: true },
      }),
      prisma.order.findMany({
        where: { userId: id },
        select: { id: true, orderNumber: true, status: true, paymentStatus: true, grandTotal: true, currency: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.session.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);

    const { wishlist, _count, ...rest } = user;
    return {
      ...flattenRoles(rest),
      stats: {
        ordersCount: _count.orders,
        reviewsCount: _count.reviews,
        wishlistCount: wishlist?._count.items ?? 0,
        totalSpent: spent._sum.grandTotal ?? 0,
        activeSessions,
      },
      recentOrders,
    };
  }

  async setBlocked(actor: Actor, ctx: AuditContext, id: string, blocked: boolean, reason?: string) {
    const target = await userLevel(id);
    assertCanManageUser(actor, target);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: blocked ? { status: UserStatus.BLOCKED, blockedReason: reason } : { status: UserStatus.ACTIVE, blockedReason: null, failedLoginAttempts: 0, lockedUntil: null },
      });
      // Bloquear termina imediatamente todas as sessões.
      if (blocked) await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'BLOCKED' } });
      await recordAudit(tx, ctx, {
        action: blocked ? 'user.block' : 'user.unblock',
        resourceType: 'User',
        resourceId: id,
        before: { status: target.status },
        after: { status: blocked ? UserStatus.BLOCKED : UserStatus.ACTIVE, reason },
      });
    });
  }

  // ---------------------------------------------------------------- staff
  async listStaff(params: ListParams) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      roles: { some: { role: { level: { gt: 0 } } } },
      ...(params.search ? { OR: [{ name: { contains: params.search, mode: 'insensitive' } }, { email: { contains: params.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, select: listSelect, orderBy: { createdAt: 'desc' }, ...toSkipTake(params) }),
    ]);
    return { items: rows.map(flattenRoles), meta: pageMeta(total, params) };
  }

  async createStaff(actor: Actor, ctx: AuditContext, input: { name: string; email: string; phone?: string; password: string; roles: string[] }) {
    const roles = await loadRoles(input.roles);
    assertCanAssignRoles(actor, roles.map((r) => ({ name: r.name, level: r.level, permissions: r.permissionKeys })));
    if (await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
      throw Errors.conflict('EMAIL_ALREADY_IN_USE', 'Email is already registered');
    }
    const passwordHash = await hashPassword(input.password);
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash,
          emailVerifiedAt: new Date(),
          roles: { create: roles.map((r) => ({ roleId: r.id, assignedById: actor.userId })) },
        },
        select: listSelect,
      });
      await recordAudit(tx, ctx, { action: 'staff.create', resourceType: 'User', resourceId: user.id, after: { email: user.email, roles: input.roles } });
      return flattenRoles(user);
    });
  }

  async setUserRoles(actor: Actor, ctx: AuditContext, id: string, roleNames: string[]) {
    const target = await userLevel(id);
    assertCanManageUser(actor, target); // inclui "não pode alterar as próprias roles"
    const roles = await loadRoles(roleNames);
    assertCanAssignRoles(actor, roles.map((r) => ({ name: r.name, level: r.level, permissions: r.permissionKeys })));

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id, assignedById: actor.userId })) });
      await recordAudit(tx, ctx, {
        action: 'user.roles.update',
        resourceType: 'User',
        resourceId: id,
        before: { roles: target.roles.map((r) => r.role.name) },
        after: { roles: roleNames },
      });
    });
    return userLevel(id).then((u) => ({ id: u.id, email: u.email, roles: u.roles.map((r) => r.role.name) }));
  }

  /** Remove o acesso administrativo (volta a ser apenas CUSTOMER) — não apaga dados históricos. */
  async removeStaff(actor: Actor, ctx: AuditContext, id: string) {
    return this.setUserRoles(actor, ctx, id, ['CUSTOMER']);
  }

  // ---------------------------------------------------------------- roles
  listPermissions() {
    return prisma.permission
      .findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }], select: { key: true, description: true, group: true } })
      .then((rows) => rows);
  }

  async listRoles() {
    const roles = await prisma.role.findMany({ include: { ...roleWithPerms, _count: { select: { users: true } } }, orderBy: { level: 'desc' } });
    return roles.map(toRoleDto);
  }

  async createRole(actor: Actor, ctx: AuditContext, input: { name: string; description?: string; level: number; permissions: string[] }) {
    assertRoleLevelAllowed(actor, input.level);
    const keys = await validatePermissionKeys(input.permissions);
    assertCanGrantPermissions(actor, keys);
    return prisma.$transaction(async (tx) => {
      const perms = await tx.permission.findMany({ where: { key: { in: keys } } });
      const role = await tx.role.create({
        data: {
          name: input.name,
          description: input.description,
          level: input.level,
          permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
        },
        include: { ...roleWithPerms, _count: { select: { users: true } } },
      });
      await recordAudit(tx, ctx, { action: 'role.create', resourceType: 'Role', resourceId: role.id, after: { name: role.name, level: role.level, permissions: keys } });
      return toRoleDto(role);
    });
  }

  async updateRole(actor: Actor, ctx: AuditContext, id: string, input: { description?: string | null; level?: number; permissions?: string[] }) {
    const role = await prisma.role.findUnique({ where: { id }, include: roleWithPerms });
    if (!role) throw Errors.notFound('Role');
    if (role.isSystem && input.level !== undefined && input.level !== role.level) {
      throw Errors.forbidden('System role levels cannot be changed', 'SYSTEM_ROLE_PROTECTED');
    }
    // Não se edita uma role do próprio nível ou acima (impede o ADMIN de se promover via role).
    assertRoleLevelAllowed(actor, role.level);
    if (input.level !== undefined) assertRoleLevelAllowed(actor, input.level);

    const beforeKeys = role.permissions.map((p) => p.permission.key);
    let keys: string[] | undefined;
    if (input.permissions) {
      keys = await validatePermissionKeys(input.permissions);
      assertCanGrantPermissions(actor, keys.filter((k) => !beforeKeys.includes(k)));
    }

    return prisma.$transaction(async (tx) => {
      if (keys) {
        const perms = await tx.permission.findMany({ where: { key: { in: keys } } });
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: id, permissionId: p.id })) });
      }
      const updated = await tx.role.update({
        where: { id },
        data: { description: input.description, level: input.level },
        include: { ...roleWithPerms, _count: { select: { users: true } } },
      });
      await recordAudit(tx, ctx, {
        action: 'role.update',
        resourceType: 'Role',
        resourceId: id,
        before: { level: role.level, permissions: beforeKeys },
        after: { level: updated.level, permissions: keys ?? beforeKeys },
      });
      return toRoleDto(updated);
    });
  }

  async deleteRole(actor: Actor, ctx: AuditContext, id: string) {
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw Errors.notFound('Role');
    if (role.isSystem) throw Errors.forbidden('System roles cannot be deleted', 'SYSTEM_ROLE_PROTECTED');
    assertRoleLevelAllowed(actor, role.level);
    if (role._count.users > 0) throw Errors.conflict('ROLE_IN_USE', 'Role is assigned to users');
    await prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id } });
      await recordAudit(tx, ctx, { action: 'role.delete', resourceType: 'Role', resourceId: id, before: { name: role.name } });
    });
  }
}

async function validatePermissionKeys(keys: string[]) {
  const unique = [...new Set(keys)];
  const unknown = unique.filter((k) => !ALL_PERMISSIONS.includes(k as never));
  if (unknown.length) throw Errors.badRequest('UNKNOWN_PERMISSION', 'Unknown permissions', { unknown, groups: [...new Set(ALL_PERMISSIONS.map(permissionGroup))] });
  return unique;
}

function flattenRoles<T extends { roles: { role: { name: string } }[] }>(u: T) {
  return { ...u, roles: u.roles.map((r) => r.role.name) };
}

function toRoleDto(r: {
  id: string;
  name: string;
  description: string | null;
  level: number;
  isSystem: boolean;
  permissions: { permission: { key: string } }[];
  _count: { users: number };
}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    level: r.level,
    isSystem: r.isSystem,
    usersCount: r._count.users,
    permissions: r.permissions.map((p) => p.permission.key).sort(),
  };
}
