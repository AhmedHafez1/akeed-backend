import { Logger, NotFoundException } from '@nestjs/common';
import { AdminStoresService } from './admin-stores.service';

const STORE = '3f2b1c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';

function setup(found = true) {
  const integrations = {
    setLogoHeaderEnabled: jest.fn().mockResolvedValue(found),
    findLogoState: jest.fn().mockResolvedValue({
      logoUrl: 'https://cdn.test/l.png',
      logoBannerUrl: 'https://cdn.test/b.jpg',
      logoUpdatedAt: '2026-10-15T10:00:00.000Z',
      logoHeaderEnabled: true,
    }),
  };
  const templates = {
    findImageTwins: jest.fn().mockResolvedValue([
      {
        imageTwinOfKey: 'cod_confirm.ar.egyptian',
        twinOf: { templateName: 'akeed_ar_egyptian', languageCode: 'ar' },
        templateName: 'akeed_ar_egyptian_logo',
        languageCode: 'ar',
        isActive: true,
        reviewStatus: 'approved',
      },
    ]),
  };
  const service = new AdminStoresService(
    {} as never,
    {} as never,
    {} as never,
    integrations as never,
    templates as never,
  );
  return { service, integrations };
}

describe('AdminStoresService logo header', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('switches the store and audits the staff member', async () => {
    const { service, integrations } = setup();

    const result = await service.setLogoHeaderEnabled('staff-1', STORE, true);

    expect(integrations.setLogoHeaderEnabled).toHaveBeenCalledWith(
      STORE,
      true,
      { userId: 'staff-1' },
    );
    expect(result.logo_header).toEqual({
      enabled: true,
      logo_url: 'https://cdn.test/l.png',
      banner_url: 'https://cdn.test/b.jpg',
      updated_at: '2026-10-15T10:00:00.000Z',
      image_twins: [
        {
          twin_of_key: 'cod_confirm.ar.egyptian',
          twin_of_template_name: 'akeed_ar_egyptian',
          template_name: 'akeed_ar_egyptian_logo',
          language_code: 'ar',
          is_active: true,
          review_status: 'approved',
        },
      ],
    });
  });

  it('answers 404 for an unknown store', async () => {
    const { service } = setup(false);
    await expect(
      service.setLogoHeaderEnabled('staff-1', STORE, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
