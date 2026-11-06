import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { DRIZZLE } from '../../infrastructure/database/database.provider';
import { EMAIL_PORT } from '../../shared/ports/email.port';
import { SenderAlertService } from './sender-alert.service';
import {
  SENDER_ALERT_QUEUE,
  SenderAlertProcessor,
  SenderAlertProducer,
} from './sender-alert-queue';

@Module({
  imports: [DatabaseModule],
  providers: [
    SenderAlertService,
    SenderAlertProcessor,
    { provide: ConfigService, useValue: new ConfigService({}) },
    { provide: EMAIL_PORT, useValue: { send: jest.fn() } },
    { provide: SenderAlertProducer, useValue: { request: jest.fn() } },
    {
      provide: getQueueToken(SENDER_ALERT_QUEUE),
      useValue: { add: jest.fn() },
    },
  ],
})
class AlertConsumerModule {}

it('resolves the alert worker through the production database module exports without opening connections', async () => {
  const module = await Test.createTestingModule({
    imports: [AlertConsumerModule],
  })
    .overrideProvider(DRIZZLE)
    .useValue({})
    .compile();
  expect(module.get(SenderAlertProcessor)).toBeInstanceOf(SenderAlertProcessor);
  expect(module.get(SenderAlertService)).toBeInstanceOf(SenderAlertService);
  await module.close();
});
