import { prisma, NotificationChannel, NotificationStatus, Prisma, type NotificationType } from '../db/client';
import { getMailer } from './mailer';

interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Também enviar email (para além da notificação interna). */
  email?: boolean;
}

/**
 * Ponto único de envio de notificações. Hoje: in-app + email (provider abstrato).
 * Push/SMS entram aqui como novos canais. Nunca falha o fluxo de negócio.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        channel: NotificationChannel.IN_APP,
        title: input.title,
        body: input.body,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        status: NotificationStatus.SENT,
        sentAt: new Date(),
      },
    });
    if (input.email) {
      const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } });
      if (user) await getMailer().send({ to: user.email, subject: input.title, text: input.body });
    }
  } catch (err) {
    console.error('notification failed', { type: input.type, err: (err as Error).message });
  }
}
