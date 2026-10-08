import { AxiosError } from 'axios';
import { throwError } from 'rxjs';
import { selectTemplateForSend } from '../../../shared/messaging/template-selector';
import { seededRegistryTemplates } from '../../../shared/messaging/testing/seeded-template-registry';
import { WhatsAppService } from './whatsapp.service';

/** A connection that never reached Meta reports why, not an empty message. */
function setup(error: unknown) {
  const httpService = {
    post: jest.fn().mockReturnValue(throwError(() => error)),
  };
  const service = new WhatsAppService(
    httpService as never,
    {
      get: (key: string) =>
        ({ WA_ACCESS_TOKEN: 'token', WA_PHONE_NUMBER_ID: 'phone' })[key],
    } as never,
  );
  return service;
}

function send(service: WhatsAppService) {
  const selection = selectTemplateForSend(seededRegistryTemplates(), {
    preferredLanguage: 'ar',
    phoneNumber: '+201148675077',
  });
  if (!selection.template) throw new Error('no template');
  return service.sendVerificationTemplate({
    to: '+201148675077',
    orderNumber: '1117',
    totalPrice: '1250.00 EGP',
    verificationId: 'ver-1',
    customerName: 'Sara',
    storeName: 'Nour',
    template: selection.template,
  });
}

describe('WhatsAppService network failure', () => {
  it('names the socket codes of an empty AggregateError in the thrown context', async () => {
    const aggregate = Object.assign(
      new AggregateError([
        Object.assign(new Error(''), { code: 'ETIMEDOUT' }),
        Object.assign(new Error(''), { code: 'ENETUNREACH' }),
      ]),
      { code: 'ETIMEDOUT' },
    );
    const axiosError = AxiosError.from(aggregate);
    const service = setup(axiosError);
    const logged: string[] = [];
    jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation((message: string) => {
        logged.push(message);
      });

    await expect(send(service)).rejects.toThrow(
      /status=unknown .* network=ETIMEDOUT,ENETUNREACH/,
    );
    expect(JSON.parse(logged[0])).toMatchObject({
      action: 'whatsapp-template-send',
      errorCauseCodes: ['ETIMEDOUT', 'ENETUNREACH'],
    });
  });

  it('adds nothing for an error that carries no code', async () => {
    const service = setup(new Error('boom'));
    jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(send(service)).rejects.not.toThrow(/network=/);
  });
});
