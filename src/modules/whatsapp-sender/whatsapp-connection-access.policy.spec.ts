import { ForbiddenException } from '@nestjs/common';
import {
  assertWhatsappConnectionChangeAllowed,
  canChangeWhatsappConnection,
  WHATSAPP_CONNECTION_OWNER_REQUIRED,
} from './whatsapp-connection-access.policy';

describe('WhatsApp connection access', () => {
  it('lets the owner change the connection', () => {
    expect(canChangeWhatsappConnection('owner')).toBe(true);
    expect(() => assertWhatsappConnectionChangeAllowed('owner')).not.toThrow();
  });

  it.each(['admin', 'viewer'] as const)(
    'refuses a %s with a stable code',
    (role) => {
      expect(canChangeWhatsappConnection(role)).toBe(false);
      let thrown: unknown;
      try {
        assertWhatsappConnectionChangeAllowed(role);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getResponse()).toMatchObject({
        statusCode: 403,
        code: WHATSAPP_CONNECTION_OWNER_REQUIRED,
      });
    },
  );
});
