import { NotificationChannel, prisma, type NotificationType, type Prisma } from '../../db/client';
import { Errors } from '../../utils/errors';
import { pageMeta, toSkipTake } from '../../utils/pagination';

/** Leitura/gestão das notificações internas (IN_APP). O envio está em utils/notifications.ts. */
export class NotificationsService {
  async list(userId: string, q: { page: number; limit: number; unread?: boolean; type?: NotificationType }) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      channel: NotificationChannel.IN_APP,
      ...(q.unread !== undefined ? { readAt: q.unread ? null : { not: null } } : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [total, items, unread] = await prisma.$transaction([
      prisma.notification.count({ where }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, title: true, body: true, data: true, readAt: true, createdAt: true },
        ...toSkipTake(q),
      }),
      prisma.notification.count({ where: { userId, channel: NotificationChannel.IN_APP, readAt: null } }),
    ]);
    return { items, meta: { ...pageMeta(total, q), unread } };
  }

  async unreadCount(userId: string) {
    return { unread: await prisma.notification.count({ where: { userId, channel: NotificationChannel.IN_APP, readAt: null } }) };
  }

  async markRead(userId: string, id: string) {
    const res = await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (res.count === 0) {
      const exists = await prisma.notification.count({ where: { id, userId } });
      if (!exists) throw Errors.notFound('Notification');
    }
  }

  async markAllRead(userId: string) {
    const res = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: res.count };
  }

  async remove(userId: string, id: string) {
    const res = await prisma.notification.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw Errors.notFound('Notification');
  }
}
