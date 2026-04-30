import { VerificationsService } from './verifications.service';

interface VerificationStatusCounts {
  total: number;
  confirmed: number;
  canceled: number;
  customerCanceled: number;
  sent: number;
  delivered: number;
  read: number;
}

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

function callReplyRate(
  svc: VerificationsService,
  counts: VerificationStatusCounts,
): number {
  return (svc as any).calculateReplyRate(counts);
}

function callConfirmationRate(
  svc: VerificationsService,
  counts: VerificationStatusCounts,
): number {
  return (svc as any).calculateConfirmationRate(counts);
}

/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

describe('VerificationsService', () => {
  let service: VerificationsService;

  beforeEach(() => {
    service = new VerificationsService(null as any, null as any, null as any);
  });

  describe('calculateReplyRate', () => {
    it('should return 0 when total is 0', () => {
      expect(
        callReplyRate(service, {
          total: 0,
          confirmed: 0,
          canceled: 0,
          customerCanceled: 0,
          sent: 0,
          delivered: 0,
          read: 0,
        }),
      ).toBe(0);
    });

    it('should return correct reply rate using customerCanceled', () => {
      expect(
        callReplyRate(service, {
          total: 100,
          confirmed: 40,
          canceled: 15,
          customerCanceled: 10,
          sent: 100,
          delivered: 80,
          read: 60,
        }),
      ).toBe(50);
    });

    it('should round to 1 decimal place', () => {
      expect(
        callReplyRate(service, {
          total: 3,
          confirmed: 1,
          canceled: 0,
          customerCanceled: 0,
          sent: 3,
          delivered: 2,
          read: 1,
        }),
      ).toBe(33.3);
    });

    it('should exclude merchant_no_reply cancellations from reply rate', () => {
      // 5 merchant_no_reply cancellations should not count as replies
      expect(
        callReplyRate(service, {
          total: 100,
          confirmed: 40,
          canceled: 15,
          customerCanceled: 10,
          sent: 100,
          delivered: 80,
          read: 60,
        }),
      ).toBe(50); // (40 + 10) / 100 = 50%, not (40 + 15) / 100 = 55%
    });

    it('should treat legacy null cancellationSource as customer cancel', () => {
      // When all canceled have customerCanceled = canceled (null source = customer)
      expect(
        callReplyRate(service, {
          total: 100,
          confirmed: 40,
          canceled: 10,
          customerCanceled: 10,
          sent: 100,
          delivered: 80,
          read: 60,
        }),
      ).toBe(50); // (40 + 10) / 100 = 50%
    });
  });

  describe('calculateConfirmationRate', () => {
    it('should return 0 when total is 0', () => {
      expect(
        callConfirmationRate(service, {
          total: 0,
          confirmed: 0,
          canceled: 0,
          customerCanceled: 0,
          sent: 0,
          delivered: 0,
          read: 0,
        }),
      ).toBe(0);
    });

    it('should return correct confirmation rate', () => {
      expect(
        callConfirmationRate(service, {
          total: 100,
          confirmed: 75,
          canceled: 10,
          customerCanceled: 10,
          sent: 100,
          delivered: 80,
          read: 60,
        }),
      ).toBe(75);
    });

    it('should round to 1 decimal place', () => {
      expect(
        callConfirmationRate(service, {
          total: 3,
          confirmed: 1,
          canceled: 0,
          customerCanceled: 0,
          sent: 3,
          delivered: 2,
          read: 1,
        }),
      ).toBe(33.3);
    });

    it('should return 100 when all are confirmed', () => {
      expect(
        callConfirmationRate(service, {
          total: 50,
          confirmed: 50,
          canceled: 0,
          customerCanceled: 0,
          sent: 50,
          delivered: 50,
          read: 50,
        }),
      ).toBe(100);
    });
  });
});
