import type { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  announcementUnsubscribeToken,
  verifyAnnouncementUnsubscribeToken,
} from './announcement-unsubscribe';
import { AnnouncementUnsubscribeService } from '../../modules/tips/announcement-unsubscribe.service';
import type { AnnouncementEmailsRepository } from '../../infrastructure/database/repositories/announcement-emails.repository';
import { AdminTipsCampaignsController } from '../../modules/admin/admin-tips-campaigns.controller';
import { AdminAccessGuard } from '../../modules/admin/admin-access.guard';

const SECRET = 'synthetic-announcement-secret-32-characters';
const ORG = '11111111-1111-4111-8111-111111111111';
describe('announcement unsubscribe boundary', () => {
  it('binds an authenticated token to exactly one organization, scope and language', () => {
    const token = announcementUnsubscribeToken(ORG, 'ur', SECRET);
    expect(verifyAnnouncementUnsubscribeToken(token, SECRET)).toEqual({
      orgId: ORG,
      locale: 'ur',
    });
    expect(
      verifyAnnouncementUnsubscribeToken(token, SECRET + 'other'),
    ).toBeNull();
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      'v1:22222222-2222-4222-8222-222222222222:ur',
    ).toString('base64url');
    expect(
      verifyAnnouncementUnsubscribeToken(`${forged}.${signature}`, SECRET),
    ).toBeNull();
  });
  it.each(['', 'abc', 'a.b', '../bad', 'x'.repeat(1000)])(
    'rejects malformed token %s',
    (token) =>
      expect(verifyAnnouncementUnsubscribeToken(token, SECRET)).toBeNull(),
  );
  it('GET changes nothing; POST writes only the signed organization preference and is safe to repeat', async () => {
    const unsubscribe = jest.fn().mockResolvedValue(undefined);
    const service = new AnnouncementUnsubscribeService(
      { unsubscribe } as unknown as AnnouncementEmailsRepository,
      {
        get: () => ({ unsubscribeSecret: SECRET }),
      } as unknown as ConfigService,
    );
    const token = announcementUnsubscribeToken(ORG, 'ar', SECRET);
    expect(service.read(token)).toContain('dir="rtl"');
    expect(unsubscribe).not.toHaveBeenCalled();
    await service.unsubscribe(token);
    await service.unsubscribe(token);
    expect(unsubscribe.mock.calls).toEqual([[ORG], [ORG]]);
    await expect(service.unsubscribe(token + 'x')).rejects.toMatchObject({
      response: { code: 'ANNOUNCEMENT_UNSUBSCRIBE_INVALID' },
    });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it('keeps every admin campaign route under the existing staff guard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminTipsCampaignsController),
    ).toContain(AdminAccessGuard);
  });
});
