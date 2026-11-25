import { describe, expect, it } from 'vitest';
import { assertCanAssignRoles, assertCanGrantPermissions, assertCanManageUser, assertRoleLevelAllowed } from '../../src/modules/users/rbac';

const admin = { userId: 'a', roleLevel: 50, permissions: new Set(['products:create', 'orders:manage']) };
const owner = { userId: 'o', roleLevel: 100, permissions: new Set(['products:create', 'admins:manage', 'roles:manage']) };

describe('RBAC anti-escalada', () => {
  it('ninguém altera as próprias roles', () => {
    expect(() => assertCanManageUser(admin, { id: 'a', level: 50 })).toThrow(/own/);
    expect(() => assertCanManageUser(owner, { id: 'o', level: 100 })).toThrow(/own/);
  });

  it('ADMIN não gere utilizadores de nível igual ou superior', () => {
    expect(() => assertCanManageUser(admin, { id: 'x', level: 50 })).toThrow();
    expect(() => assertCanManageUser(admin, { id: 'x', level: 100 })).toThrow();
    expect(() => assertCanManageUser(admin, { id: 'x', level: 0 })).not.toThrow();
  });

  it('não concede permissões que não tem nem roles acima do seu nível', () => {
    expect(() => assertCanGrantPermissions(admin, ['admins:manage'])).toThrow(/cannot grant/);
    expect(() => assertCanAssignRoles(admin, [{ name: 'OWNER', level: 100, permissions: [] }])).toThrow();
    expect(() => assertRoleLevelAllowed(admin, 50)).toThrow();
    expect(() => assertRoleLevelAllowed(admin, 40)).not.toThrow();
  });

  it('OWNER (topo) pode atribuir o topo', () => {
    expect(() => assertCanAssignRoles(owner, [{ name: 'OWNER', level: 100, permissions: ['admins:manage'] }])).not.toThrow();
  });
});
