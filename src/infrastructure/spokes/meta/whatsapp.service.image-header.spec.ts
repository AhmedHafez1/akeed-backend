import { Logger } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ConfirmedMessageRejection } from '../../../shared/ports/messaging.port';
import { selectTemplateForSend } from '../../../shared/messaging/template-selector';
import { seededRegistryTemplates } from '../../../shared/messaging/testing/seeded-template-registry';
import { WhatsAppService } from './whatsapp.service';

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

const BANNER = 'https://cdn.example.test/logos/abc-banner.jpg';

function setup() {
  const httpService = { post: jest.fn() };
  const service = new WhatsAppService(
    httpService as never,
    {
      get: (key: string) =>
        ({ WA_ACCESS_TOKEN: 'token', WA_PHONE_NUMBER_ID: 'phone' })[key],
    } as never,
  );
  return { service, httpService };
}

function textTemplate() {
  const selection = selectTemplateForSend(seededRegistryTemplates(), {
    preferredLanguage: 'ar',
    phoneNumber: '+966501234567',
  });
  if (!selection.template) throw new Error('no template');
  return selection.template;
}

function withImage() {
  const template = textTemplate();
  return {
    ...template,
    imageHeader: {
      templateName: `${template.templateName}_logo`,
      languageCode: template.languageCode,
      imageUrl: BANNER,
    },
  };
}

function providerError(status: number, code?: number) {
  return new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: code === undefined ? {} : { error: { code } },
  });
}

const params = {
  to: '+966501234567',
  customerName: 'Sara',
  storeName: 'Shop',
  orderNumber: '1117',
  totalPrice: '1250.00 SAR',
  verificationId: 'ver-1',
};

const accepted = of({ data: { messages: [{ id: 'wamid.1' }] } });

describe('WhatsAppService image header', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the twin with the banner as the header image', async () => {
    const { service, httpService } = setup();
    httpService.post.mockReturnValue(accepted);
    const template = withImage();

    const result = await service.sendVerificationTemplate({
      ...params,
      template,
    });

    expect(httpService.post).toHaveBeenCalledTimes(1);
    const payload = httpService.post.mock.calls[0][1];
    expect(payload.template.name).toBe(template.imageHeader.templateName);
    expect(payload.template.components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { link: BANNER } }],
    });
    expect(payload.template.components[1].type).toBe('body');
    expect(result.template).toEqual({
      variantKey: template.variantKey,
      language: template.language,
      templateName: template.imageHeader.templateName,
      languageCode: template.languageCode,
    });
  });

  it('keeps the body and buttons identical to the text send', async () => {
    const image = setup();
    image.httpService.post.mockReturnValue(accepted);
    await image.service.sendVerificationTemplate({
      ...params,
      template: withImage(),
    });
    const text = setup();
    text.httpService.post.mockReturnValue(accepted);
    await text.service.sendVerificationTemplate({
      ...params,
      template: textTemplate(),
    });

    const imageComponents = image.httpService.post.mock.calls[0][1].template
      .components as unknown[];
    const textComponents =
      text.httpService.post.mock.calls[0][1].template.components;
    expect(imageComponents.slice(1)).toEqual(textComponents);
  });

  it.each([131053, 132012, 132001])(
    'sends the text template once after a %s refusal and reports it',
    async (code) => {
      const { service, httpService } = setup();
      httpService.post
        .mockReturnValueOnce(throwError(() => providerError(400, code)))
        .mockReturnValueOnce(accepted);
      const template = withImage();

      const result = await service.sendVerificationTemplate({
        ...params,
        template,
      });

      expect(httpService.post).toHaveBeenCalledTimes(2);
      const retry = httpService.post.mock.calls[1][1];
      expect(retry.template.name).toBe(template.templateName);
      expect(retry.template.components[0].type).toBe('body');
      expect(result.template?.templateName).toBe(template.templateName);
      expect(result.messages?.[0]?.id).toBe('wamid.1');
    },
  );

  it('does not retry a server error: the image may have been sent', async () => {
    const { service, httpService } = setup();
    httpService.post.mockReturnValue(throwError(() => providerError(500)));

    await expect(
      service.sendVerificationTemplate({ ...params, template: withImage() }),
    ).rejects.toThrow('WhatsApp send failed');
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refusal the text template would get too', async () => {
    const { service, httpService } = setup();
    httpService.post.mockReturnValue(
      throwError(() => providerError(400, 131026)),
    );

    const sent = service.sendVerificationTemplate({
      ...params,
      template: withImage(),
    });

    await expect(sent).rejects.toBeInstanceOf(ConfirmedMessageRejection);
    await expect(sent).rejects.toMatchObject({ providerErrorCode: '131026' });
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('reports a failed text retry like any text send', async () => {
    const { service, httpService } = setup();
    httpService.post
      .mockReturnValueOnce(throwError(() => providerError(400, 132012)))
      .mockReturnValueOnce(throwError(() => providerError(400, 132000)));

    await expect(
      service.sendVerificationTemplate({ ...params, template: withImage() }),
    ).rejects.toBeInstanceOf(ConfirmedMessageRejection);
    expect(httpService.post).toHaveBeenCalledTimes(2);
  });
});
