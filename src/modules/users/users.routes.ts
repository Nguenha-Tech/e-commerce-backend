import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { PERMISSIONS } from '../../config/permissions';
import { auditContext } from '../../utils/audit';
import { ok } from '../../utils/response';
import type { Actor } from './rbac';
import { UsersAdminService } from './users.admin.service';
import {
  blockUserBody,
  createAddressBody,
  createRoleBody,
  createStaffBody,
  idParams,
  listUsersQuery,
  setRolesBody,
  updateAddressBody,
  updateProfileBody,
  updateRoleBody,
} from './users.schemas';
import { UsersService } from './users.service';

/** /api/v1/users — conta do próprio utilizador. */
export const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new UsersService();
  const tags = ['Users'];
  app.addHook('preHandler', app.authenticate);

  app.get('/me', { schema: { tags, summary: 'Perfil do utilizador autenticado' } }, async (request) => {
    const { userId, permissions, roles } = request.auth!;
    return ok(await service.getMe(userId, permissions, roles));
  });

  app.patch('/me', { schema: { tags, summary: 'Atualizar perfil', body: updateProfileBody } }, async (request) =>
    ok(await service.updateMe(request.auth!.userId, request.body), 'Profile updated successfully'),
  );

  app.get('/me/addresses', { schema: { tags, summary: 'Listar endereços' } }, async (request) =>
    ok(await service.listAddresses(request.auth!.userId)),
  );

  app.post('/me/addresses', { schema: { tags, summary: 'Criar endereço', body: createAddressBody } }, async (request, reply) =>
    reply.code(201).send(ok(await service.createAddress(request.auth!.userId, request.body), 'Address created successfully')),
  );

  app.patch('/me/addresses/:id', { schema: { tags, summary: 'Editar endereço', params: idParams, body: updateAddressBody } }, async (request) =>
    ok(await service.updateAddress(request.auth!.userId, request.params.id, request.body), 'Address updated successfully'),
  );

  app.post('/me/addresses/:id/default', { schema: { tags, summary: 'Definir endereço principal', params: idParams } }, async (request) =>
    ok(await service.setDefaultAddress(request.auth!.userId, request.params.id), 'Default address updated'),
  );

  app.delete('/me/addresses/:id', { schema: { tags, summary: 'Remover endereço', params: idParams } }, async (request) => {
    await service.deleteAddress(request.auth!.userId, request.params.id);
    return ok(null, 'Address deleted successfully');
  });
};

/** /api/v1/admin — clientes, staff, roles e permissões. */
export const usersAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new UsersAdminService();
  const tags = ['Admin · Users & Roles'];
  const P = PERMISSIONS;
  app.addHook('preHandler', app.authenticate);
  const actorOf = (r: { auth?: Actor }) => r.auth! as Actor;

  // Clientes
  app.get('/customers', { preHandler: app.authorize(P.CUSTOMERS_READ), schema: { tags, summary: 'Listar/pesquisar clientes', querystring: listUsersQuery } }, async (request) => {
    const { items, meta } = await service.listCustomers(request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/customers/:id', { preHandler: app.authorize(P.CUSTOMERS_READ), schema: { tags, summary: 'Perfil, pedidos e total gasto', params: idParams } }, async (request) =>
    ok(await service.getCustomer(request.params.id)),
  );

  app.post(
    '/customers/:id/block',
    { preHandler: app.authorize(P.CUSTOMERS_BLOCK), schema: { tags, summary: 'Bloquear cliente', params: idParams, body: blockUserBody } },
    async (request) => {
      await service.setBlocked(actorOf(request), auditContext(request), request.params.id, true, request.body.reason);
      return ok(null, 'User blocked successfully');
    },
  );

  app.post('/customers/:id/unblock', { preHandler: app.authorize(P.CUSTOMERS_BLOCK), schema: { tags, summary: 'Desbloquear cliente', params: idParams } }, async (request) => {
    await service.setBlocked(actorOf(request), auditContext(request), request.params.id, false);
    return ok(null, 'User unblocked successfully');
  });

  // Staff / administradores (OWNER)
  app.get('/staff', { preHandler: app.authorize(P.ADMINS_MANAGE), schema: { tags, summary: 'Listar administradores', querystring: listUsersQuery } }, async (request) => {
    const { items, meta } = await service.listStaff(request.query);
    return ok(items, 'OK', meta);
  });

  app.post('/staff', { preHandler: app.authorize(P.ADMINS_MANAGE), schema: { tags, summary: 'Criar administrador', body: createStaffBody } }, async (request, reply) =>
    reply.code(201).send(ok(await service.createStaff(actorOf(request), auditContext(request), request.body), 'Staff member created successfully')),
  );

  app.put(
    '/users/:id/roles',
    { preHandler: app.authorize(P.ADMINS_MANAGE), schema: { tags, summary: 'Definir roles de um utilizador', params: idParams, body: setRolesBody } },
    async (request) => ok(await service.setUserRoles(actorOf(request), auditContext(request), request.params.id, request.body.roles), 'Roles updated successfully'),
  );

  app.delete('/staff/:id', { preHandler: app.authorize(P.ADMINS_MANAGE), schema: { tags, summary: 'Remover acesso administrativo', params: idParams } }, async (request) =>
    ok(await service.removeStaff(actorOf(request), auditContext(request), request.params.id), 'Staff access removed'),
  );

  // Roles e permissões (OWNER)
  app.get('/permissions', { preHandler: app.authorize(P.ROLES_MANAGE), schema: { tags, summary: 'Catálogo de permissões' } }, async () => ok(await service.listPermissions()));
  app.get('/roles', { preHandler: app.authorize(P.ROLES_MANAGE), schema: { tags, summary: 'Listar roles' } }, async () => ok(await service.listRoles()));

  app.post('/roles', { preHandler: app.authorize(P.ROLES_MANAGE), schema: { tags, summary: 'Criar role', body: createRoleBody } }, async (request, reply) =>
    reply.code(201).send(ok(await service.createRole(actorOf(request), auditContext(request), request.body), 'Role created successfully')),
  );

  app.patch('/roles/:id', { preHandler: app.authorize(P.ROLES_MANAGE), schema: { tags, summary: 'Editar role', params: idParams, body: updateRoleBody } }, async (request) =>
    ok(await service.updateRole(actorOf(request), auditContext(request), request.params.id, request.body), 'Role updated successfully'),
  );

  app.delete('/roles/:id', { preHandler: app.authorize(P.ROLES_MANAGE), schema: { tags, summary: 'Apagar role', params: idParams } }, async (request) => {
    await service.deleteRole(actorOf(request), auditContext(request), request.params.id);
    return ok(null, 'Role deleted successfully');
  });
};
