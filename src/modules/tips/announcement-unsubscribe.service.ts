import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnnouncementEmailsRepository } from '../../infrastructure/database/repositories/announcement-emails.repository';
import { readAnnouncementEmailConfig } from '../../shared/config/announcement-email.config';
import { verifyAnnouncementUnsubscribeToken } from '../../shared/tips-campaigns/announcement-unsubscribe';

const COPY = {
  en: [
    'Unsubscribe from announcements',
    'Stop announcement emails for your organization. Transactional emails are unchanged.',
    'Unsubscribed',
    'Your organization will no longer receive announcement emails.',
  ],
  ar: [
    'إلغاء الاشتراك في الإعلانات',
    'أوقف رسائل الإعلانات لمؤسستك. لا تتأثر رسائل المعاملات.',
    'تم إلغاء الاشتراك',
    'لن تتلقى مؤسستك رسائل إعلانية أخرى.',
  ],
  ur: [
    'اعلانات کی ای میلز بند کریں',
    'اپنی تنظیم کے لیے اعلانات بند کریں۔ لین دین کی ای میلز متاثر نہیں ہوں گی۔',
    'اعلانات بند کر دیے گئے',
    'آپ کی تنظیم کو آئندہ اعلانات کی ای میلز نہیں ملیں گی۔',
  ],
  es: [
    'Dejar de recibir anuncios',
    'Deja de recibir anuncios para tu organización. Los correos transaccionales no cambian.',
    'Suscripción cancelada',
    'Tu organización ya no recibirá correos de anuncios.',
  ],
  fr: [
    'Se désabonner des annonces',
    'Arrêtez les annonces pour votre organisation. Les e-mails transactionnels restent inchangés.',
    'Désabonnement effectué',
    'Votre organisation ne recevra plus d’annonces par e-mail.',
  ],
  tr: [
    'Duyuru aboneliğinden çık',
    'Kuruluşunuz için duyuru e-postalarını durdurun. İşlem e-postaları etkilenmez.',
    'Abonelikten çıkıldı',
    'Kuruluşunuz artık duyuru e-postası almayacak.',
  ],
} as const;

@Injectable()
export class AnnouncementUnsubscribeService {
  constructor(
    private readonly deliveries: AnnouncementEmailsRepository,
    private readonly config: ConfigService,
  ) {}
  read(token: string | undefined): string {
    return this.page(token, false);
  }

  async unsubscribe(token: string | undefined): Promise<string> {
    const identity = this.identity(token);
    await this.deliveries.unsubscribe(identity.orgId);
    return this.page(token, true);
  }
  private identity(token: string | undefined) {
    const secret = readAnnouncementEmailConfig(this.config).unsubscribeSecret;
    const identity =
      typeof token === 'string' && secret
        ? verifyAnnouncementUnsubscribeToken(token, secret)
        : null;
    if (!identity)
      throw new BadRequestException({
        code: 'ANNOUNCEMENT_UNSUBSCRIBE_INVALID',
        message: 'This unsubscribe link is invalid.',
      });
    return identity;
  }
  private page(token: string | undefined, done: boolean): string {
    const { locale } = this.identity(token);
    const copy = COPY[locale];
    // The verified token contains only base64url characters and a dot.
    return `<!doctype html><html lang="${locale}" dir="${['ar', 'ur'].includes(locale) ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy[done ? 2 : 0]}</title></head><body style="font:18px/1.8 Arial,sans-serif;max-width:600px;margin:60px auto;padding:24px"><h1>${copy[done ? 2 : 0]}</h1><p>${copy[done ? 3 : 1]}</p>${done ? '' : `<form method="post" action="?token=${token}"><button type="submit" style="font:inherit;padding:12px 20px">${copy[0]}</button></form>`}</body></html>`;
  }
}
