import { SYSTEM_ROLES } from '../../config/permissions';
import { Errors } from '../../utils/errors';

/** Regras anti-escalada de privilégios (funções puras — testadas isoladamente). */

export const TOP_LEVEL = SYSTEM_ROLES.OWNER.level;

export interface Actor {
  userId: string;
  roleLevel: number;
  permissions: Set<string>;
}

export interface RoleLike {
  name: string;
  level: number;
  permissions: string[];
}

/** Só gere quem está abaixo na hierarquia (o topo gere todos); nunca a si próprio. */
export function assertCanManageUser(actor: Actor, target: { id: string; level: number }): void {
  if (actor.userId === target.id) throw Errors.forbidden('You cannot change your own roles or status', 'CANNOT_MODIFY_SELF');
  if (target.level >= actor.roleLevel && actor.roleLevel < TOP_LEVEL) {
    throw Errors.forbidden('You cannot manage a user with equal or higher privileges', 'INSUFFICIENT_HIERARCHY');
  }
}

/** Só concede permissões que o próprio possui. */
export function assertCanGrantPermissions(actor: Actor, permissions: string[]): void {
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length) {
    throw Errors.forbidden('You cannot grant permissions you do not have', 'PERMISSION_ESCALATION', { missing });
  }
}

/** Só atribui roles abaixo do seu nível (o topo pode atribuir o topo) e sem permissões que não tem. */
export function assertCanAssignRoles(actor: Actor, roles: RoleLike[]): void {
  for (const role of roles) {
    if (role.level >= actor.roleLevel && actor.roleLevel < TOP_LEVEL) {
      throw Errors.forbidden(`You cannot assign the role ${role.name}`, 'ROLE_ESCALATION');
    }
    assertCanGrantPermissions(actor, role.permissions);
  }
}

/** Uma role criada/editada nunca pode ficar ao nível do ator (exceto para o topo). */
export function assertRoleLevelAllowed(actor: Actor, level: number): void {
  if (level >= actor.roleLevel && actor.roleLevel < TOP_LEVEL) {
    throw Errors.forbidden('Role level must be lower than your own', 'ROLE_ESCALATION');
  }
}
