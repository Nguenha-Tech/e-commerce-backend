import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Abstração de email: trocar ConsoleMailer por SES/SendGrid/SMTP sem mexer nos serviços. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger | Console = console) {}

  async send(message: MailMessage): Promise<void> {
    if (env.isProd) {
      // Em produção nunca escrever o corpo (pode conter links com tokens).
      this.log.info({ to: message.to, subject: message.subject }, 'email (console provider)');
      return;
    }
    if (env.isTest) return;
    this.log.info({ to: message.to, subject: message.subject, text: message.text }, 'email (console provider)');
  }
}

let mailer: Mailer = new ConsoleMailer();

export const getMailer = () => mailer;
export const setMailer = (m: Mailer) => {
  mailer = m;
};
