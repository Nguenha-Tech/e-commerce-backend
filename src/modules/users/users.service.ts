import { prisma } from '../../db/client';
import { Errors } from '../../utils/errors';
import type { CreateAddressInput, UpdateAddressInput, UpdateProfileInput } from './users.schemas';

const MAX_ADDRESSES = 15;

/** Nunca selecionar passwordHash, tokens ou contadores internos para o cliente. */
const profileSelect = {
  id: true,
  name: true,
  username: true,
  email: true,
  phone: true,
  avatarUrl: true,
  country: true,
  province: true,
  city: true,
  birthDate: true,
  status: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const addressSelect = {
  id: true,
  label: true,
  type: true,
  recipientName: true,
  phone: true,
  country: true,
  province: true,
  city: true,
  neighborhood: true,
  street: true,
  number: true,
  reference: true,
  postalCode: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class UsersService {
  async getMe(userId: string, permissions: Set<string>, roles: string[]) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: profileSelect });
    if (!user) throw Errors.notFound('User');
    return { ...user, emailVerified: Boolean(user.emailVerifiedAt), roles, permissions: [...permissions].sort() };
  }

  async updateMe(userId: string, input: UpdateProfileInput) {
    if (input.username) {
      const taken = await prisma.user.findFirst({ where: { username: input.username, id: { not: userId } }, select: { id: true } });
      if (taken) throw Errors.conflict('USERNAME_TAKEN', 'Username is already taken');
    }
    let phoneChanged = false;
    if (input.phone !== undefined) {
      const current = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } });
      phoneChanged = current.phone !== input.phone;
      if (input.phone && phoneChanged) {
        const taken = await prisma.user.findFirst({ where: { phone: input.phone, id: { not: userId } }, select: { id: true } });
        if (taken) throw Errors.conflict('PHONE_ALREADY_IN_USE', 'Phone is already registered');
      }
    }
    // O email não se altera aqui: exige fluxo próprio com reconfirmação.
    return prisma.user.update({
      where: { id: userId },
      data: { ...input, ...(phoneChanged ? { phoneVerifiedAt: null } : {}) },
      select: profileSelect,
    });
  }

  // ------------------------------------------------------------- endereços
  listAddresses(userId: string) {
    return prisma.address.findMany({
      where: { userId, deletedAt: null },
      select: addressSelect,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getAddress(userId: string, id: string) {
    const address = await prisma.address.findFirst({ where: { id, userId, deletedAt: null }, select: addressSelect });
    if (!address) throw Errors.notFound('Address');
    return address;
  }

  async createAddress(userId: string, input: CreateAddressInput) {
    return prisma.$transaction(async (tx) => {
      const count = await tx.address.count({ where: { userId, deletedAt: null } });
      if (count >= MAX_ADDRESSES) throw Errors.unprocessable('ADDRESS_LIMIT_REACHED', `Maximum of ${MAX_ADDRESSES} addresses`);
      const isDefault = input.isDefault || count === 0; // o primeiro é sempre o principal
      if (isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.create({ data: { ...input, isDefault, userId }, select: addressSelect });
    });
  }

  async updateAddress(userId: string, id: string, input: UpdateAddressInput) {
    await this.getAddress(userId, id);
    return prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      if (input.isDefault === false) delete input.isDefault; // tem de existir sempre um principal
      return tx.address.update({ where: { id }, data: input, select: addressSelect });
    });
  }

  async setDefaultAddress(userId: string, id: string) {
    return this.updateAddress(userId, id, { isDefault: true });
  }

  /** Soft delete: pedidos antigos guardam snapshot do endereço, mas mantemos o registo. */
  async deleteAddress(userId: string, id: string) {
    const address = await this.getAddress(userId, id);
    await prisma.$transaction(async (tx) => {
      await tx.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });
      if (address.isDefault) {
        const next = await tx.address.findFirst({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }
}
