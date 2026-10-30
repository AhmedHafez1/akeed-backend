import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  const appService = {
    getHello: jest.fn(() => 'Hello World!'),
    getHealth: jest.fn(() =>
      Promise.resolve({
        status: 'ok',
        timestamp: '2026-05-24T00:00:00.000Z',
        checks: { database: 'ok' },
      }),
    ),
  };
  const response = { status: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: AppService, useValue: appService }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('should return health check state', async () => {
      await expect(
        appController.getHealth(response as unknown as Response),
      ).resolves.toEqual({
        status: 'ok',
        timestamp: '2026-05-24T00:00:00.000Z',
        checks: { database: 'ok' },
      });
      expect(response.status).not.toHaveBeenCalled();
    });

    it('answers 503 when the database is unreachable', async () => {
      const degraded = {
        status: 'degraded',
        timestamp: '2026-05-24T00:00:00.000Z',
        checks: { database: 'error' },
      };
      appService.getHealth.mockResolvedValueOnce(degraded);

      await expect(
        appController.getHealth(response as unknown as Response),
      ).resolves.toEqual(degraded);
      expect(response.status).toHaveBeenCalledWith(503);
    });
  });
});
